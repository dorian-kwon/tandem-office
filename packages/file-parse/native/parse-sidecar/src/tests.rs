use std::fs;
use std::io::{Cursor, Write};
use std::path::Path;
use std::sync::atomic::AtomicBool;

use flate2::Compression;
use flate2::write::DeflateEncoder;
use serde_json::Value;
use tempfile::tempdir;

use crate::extract::{ExtractOptions, extract_file, rels};
use crate::protocol::{ExtractResult, FallbackReason, RejectCode, TokenizedStrings};
use crate::scan::{document_extension, is_hidden_entry, is_supported_tree_file, scan_dir};
use crate::tokenize::{is_cjk, tokenize_text, truncate_utf16_units};
use crate::zip_gate::{DEFAULT_ZIP_LIMITS, ZipArchive, ZipGateError, ZipLimits, is_text_part};

/// Minimal test ZIP builder supporting stored/deflated entries and deliberate header tampering.
struct TestZipEntry {
    name: Vec<u8>,
    data: Vec<u8>,
    method: u16,
    flags: u16,
    declared_usize: Option<u32>,
    declared_csize: Option<u32>,
}

impl TestZipEntry {
    fn deflate(name: &str, data: &[u8]) -> Self {
        Self {
            name: name.as_bytes().to_vec(),
            data: data.to_vec(),
            method: 8,
            flags: 0x0800,
            declared_usize: None,
            declared_csize: None,
        }
    }

    fn stored(name: &str, data: &[u8]) -> Self {
        Self {
            name: name.as_bytes().to_vec(),
            data: data.to_vec(),
            method: 0,
            flags: 0x0800,
            declared_usize: None,
            declared_csize: None,
        }
    }
}

fn build_test_zip(entries: &[TestZipEntry]) -> Vec<u8> {
    let mut local_buf = Vec::new();
    let mut central_buf = Vec::new();

    for entry in entries {
        let compressed = if entry.method == 8 {
            let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
            enc.write_all(&entry.data).unwrap();
            enc.finish().unwrap()
        } else {
            entry.data.clone()
        };
        let csize = entry.declared_csize.unwrap_or(compressed.len() as u32);
        let usize_val = entry.declared_usize.unwrap_or(entry.data.len() as u32);
        let local_offset = local_buf.len() as u32;

        // Local file header
        local_buf.extend_from_slice(&0x04034b50u32.to_le_bytes());
        local_buf.extend_from_slice(&20u16.to_le_bytes());
        local_buf.extend_from_slice(&entry.flags.to_le_bytes());
        local_buf.extend_from_slice(&entry.method.to_le_bytes());
        local_buf.extend_from_slice(&0u16.to_le_bytes());
        local_buf.extend_from_slice(&0u16.to_le_bytes());
        local_buf.extend_from_slice(&0u32.to_le_bytes());
        local_buf.extend_from_slice(&csize.to_le_bytes());
        local_buf.extend_from_slice(&usize_val.to_le_bytes());
        local_buf.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
        local_buf.extend_from_slice(&0u16.to_le_bytes());
        local_buf.extend_from_slice(&entry.name);
        local_buf.extend_from_slice(&compressed);

        // Central directory header
        central_buf.extend_from_slice(&0x02014b50u32.to_le_bytes());
        central_buf.extend_from_slice(&20u16.to_le_bytes());
        central_buf.extend_from_slice(&20u16.to_le_bytes());
        central_buf.extend_from_slice(&entry.flags.to_le_bytes());
        central_buf.extend_from_slice(&entry.method.to_le_bytes());
        central_buf.extend_from_slice(&0u16.to_le_bytes());
        central_buf.extend_from_slice(&0u16.to_le_bytes());
        central_buf.extend_from_slice(&0u32.to_le_bytes());
        central_buf.extend_from_slice(&csize.to_le_bytes());
        central_buf.extend_from_slice(&usize_val.to_le_bytes());
        central_buf.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
        central_buf.extend_from_slice(&0u16.to_le_bytes());
        central_buf.extend_from_slice(&0u16.to_le_bytes());
        central_buf.extend_from_slice(&0u16.to_le_bytes());
        central_buf.extend_from_slice(&0u16.to_le_bytes());
        central_buf.extend_from_slice(&0u32.to_le_bytes());
        central_buf.extend_from_slice(&local_offset.to_le_bytes());
        central_buf.extend_from_slice(&entry.name);
    }

    let cd_offset = local_buf.len() as u32;
    let cd_size = central_buf.len() as u32;
    let count = entries.len() as u16;

    let mut out = local_buf;
    out.extend_from_slice(&central_buf);
    // EOCD
    out.extend_from_slice(&0x06054b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

fn write_temp_file(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let path = dir.join(name);
    fs::write(&path, bytes).unwrap();
    path
}

#[test]
fn fallback_result_never_serializes_text_or_tokens() {
    let res = ExtractResult::Fallback {
        fallback_reason: FallbackReason::RedactionPresent,
    };
    let val: Value = serde_json::to_value(&res).unwrap();
    assert_eq!(val["status"], "fallback");
    assert_eq!(val["fallbackReason"], "redaction_present");
    assert!(val.get("text").is_none());
    assert!(val.get("tokens").is_none());
}

#[test]
fn rels_resolve_target_matches_opc_rules() {
    assert_eq!(
        rels::resolve_target("word/document.xml", "styles.xml"),
        "word/styles.xml"
    );
    assert_eq!(
        rels::resolve_target("ppt/slides/slide1.xml", "../notesSlides/notesSlide1.xml"),
        "ppt/notesSlides/notesSlide1.xml"
    );
    assert_eq!(
        rels::resolve_target("ppt/slides/slide1.xml", "../../../../etc/passwd"),
        "etc/passwd"
    );
    assert_eq!(
        rels::resolve_target("ppt/slides/slide1.xml", "\\ppt\\slides\\slide2.xml"),
        "ppt/slides/slide2.xml"
    );
    assert_eq!(
        rels::resolve_target("word/document.xml", "https://example.com/a"),
        ""
    );
    assert_eq!(
        rels::resolve_target("word/document.xml", "file:///etc/passwd"),
        ""
    );
    assert_eq!(rels::resolve_target("word/document.xml", "%ZZbad"), "");
    assert_eq!(
        rels::resolve_target("word/document.xml", "media/hello%20world.xml"),
        "word/media/hello world.xml"
    );
}

#[test]
fn zip_gate_rejects_forged_declared_size() {
    let payload = vec![b'A'; 4096];
    let mut entry = TestZipEntry::deflate("word/document.xml", &payload);
    entry.declared_usize = Some(100);
    let zip_bytes = build_test_zip(&[entry]);
    let err = ZipArchive::open_and_verify(
        Cursor::new(zip_bytes),
        DEFAULT_ZIP_LIMITS,
        &AtomicBool::new(false),
    )
    .err()
    .expect("forged usize must fail");
    match err {
        ZipGateError::Rejected(msg) => {
            assert!(
                msg.starts_with("zip rejected:"),
                "unexpected message: {msg}"
            );
        }
        other => panic!("expected ZipGateError::Rejected, got {other:?}"),
    }
}

#[test]
fn zip_gate_rejects_zip64_encrypted_and_unsupported_method() {
    let mut enc_entry = TestZipEntry::stored("a.xml", b"hello");
    enc_entry.flags |= 0x1;
    let enc_zip = build_test_zip(&[enc_entry]);
    let err = ZipArchive::open_and_verify(
        Cursor::new(enc_zip),
        DEFAULT_ZIP_LIMITS,
        &AtomicBool::new(false),
    )
    .err()
    .unwrap();
    assert!(matches!(err, ZipGateError::Rejected(_)));

    let mut bad_method = TestZipEntry::stored("a.xml", b"hello");
    bad_method.method = 99;
    let bad_zip = build_test_zip(&[bad_method]);
    let err = ZipArchive::open_and_verify(
        Cursor::new(bad_zip),
        DEFAULT_ZIP_LIMITS,
        &AtomicBool::new(false),
    )
    .err()
    .unwrap();
    assert!(matches!(err, ZipGateError::Rejected(_)));

    // Zip64 sentinel count 0xffff
    let mut z64 = build_test_zip(&[TestZipEntry::stored("a.xml", b"hi")]);
    let len = z64.len();
    z64[len - 12] = 0xff;
    z64[len - 11] = 0xff;
    let err = ZipArchive::open_and_verify(
        Cursor::new(z64),
        DEFAULT_ZIP_LIMITS,
        &AtomicBool::new(false),
    )
    .err()
    .unwrap();
    assert!(matches!(err, ZipGateError::Rejected(_)));
}

#[test]
fn zip_gate_enforces_part_and_total_limits() {
    let zip_bytes = build_test_zip(&[
        TestZipEntry::deflate("a.xml", b"0123456789"),
        TestZipEntry::deflate("b.xml", b"0123456789"),
    ]);
    let small_limits = ZipLimits {
        max_parts: 1,
        max_part_bytes: 1024,
        max_total_bytes: 1024,
    };
    assert!(matches!(
        ZipArchive::open_and_verify(
            Cursor::new(zip_bytes.clone()),
            small_limits,
            &AtomicBool::new(false)
        ),
        Err(ZipGateError::Rejected(_))
    ));

    let small_total = ZipLimits {
        max_parts: 10,
        max_part_bytes: 1024,
        max_total_bytes: 15,
    };
    assert!(matches!(
        ZipArchive::open_and_verify(Cursor::new(zip_bytes), small_total, &AtomicBool::new(false)),
        Err(ZipGateError::Rejected(_))
    ));

    assert!(is_text_part("mimetype"));
    assert!(is_text_part("word/document.xml"));
    assert!(is_text_part("word/_rels/document.xml.rels"));
    assert!(!is_text_part("word/media/image1.png"));
    assert!(!is_text_part("ppt/media/video1.mp4"));
}

#[test]
fn tokenize_cjk_nfkc_and_combining_marks() {
    assert!(is_cjk('한' as u32));
    assert!(is_cjk('字' as u32));
    assert!(!is_cjk('A' as u32));

    // Fullwidth NFKC folding + Korean bigrams + single Han char + combining mark (e + acute)
    let input = "ＡＢＣ ２０２６ 회의록 e\u{0301}x 單";
    let tok = tokenize_text(input);
    assert_eq!(
        tok,
        TokenizedStrings {
            bi: "abc 2026 회의 의록 \u{00e9}x 單".to_owned(),
            uni: "abc 2026 회 의 록 \u{00e9}x 單".to_owned(),
        }
    );

    // Combining mark that does NOT precompose under NFKC (a + U+0323 + U+0302 or x + U+0301)
    let non_precomposed = tokenize_text("x\u{0301}y");
    assert_eq!(non_precomposed.bi, "x\u{0301}y");
    assert_eq!(non_precomposed.uni, "x\u{0301}y");

    // UTF-16 truncation must not split surrogate pairs
    let emoji = "a😀b"; // 'a'=1, '😀'=2, 'b'=1 UTF-16 units
    assert_eq!(truncate_utf16_units(emoji, 2), "a");
    assert_eq!(truncate_utf16_units(emoji, 3), "a😀");
}

#[test]
fn scan_dir_rules_extensions_hidden_and_limits() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    assert_eq!(document_extension("flow.drawio.svg"), "svg");
    assert_eq!(document_extension("flow.DRAWIO.PNG"), "png");
    assert_eq!(document_extension("Report.DOCX"), "docx");
    assert_eq!(document_extension(".hidden"), "");
    assert!(is_supported_tree_file("notes.md"));
    assert!(!is_supported_tree_file("chart.drawio.png"));
    assert!(!is_supported_tree_file("photo.png"));

    fs::write(root.join("report.docx"), b"x").unwrap();
    fs::write(root.join("diagram.drawio.svg"), b"x").unwrap();
    fs::write(root.join("~$lock.docx"), b"x").unwrap();
    fs::write(root.join(".dotfile.md"), b"x").unwrap();
    fs::write(root.join("Thumbs.db"), b"x").unwrap();
    fs::write(root.join("ignore.png"), b"x").unwrap();

    fs::create_dir(root.join("node_modules")).unwrap();
    fs::write(root.join("node_modules/a.md"), b"x").unwrap();
    fs::create_dir(root.join("assets")).unwrap();
    fs::write(root.join("assets/.genoffice-assets.json"), b"{}").unwrap();
    fs::write(root.join("assets/inside.md"), b"x").unwrap();
    fs::create_dir(root.join("sub")).unwrap();
    fs::write(root.join("sub/notes.txt"), b"hello").unwrap();

    assert!(is_hidden_entry(root, "assets", true));
    assert!(is_hidden_entry(root, "node_modules", true));
    assert!(is_hidden_entry(root, "Thumbs.db", false));

    let res = scan_dir(root, None, None, &AtomicBool::new(false)).unwrap();
    assert!(!res.truncated);
    let mut names: Vec<String> = res
        .files
        .iter()
        .map(|f| {
            Path::new(&f.path)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    names.sort();
    assert_eq!(names, vec!["notes.txt", "report.docx"]);

    let limited = scan_dir(root, Some(0), None, &AtomicBool::new(false)).unwrap();
    assert!(limited.truncated);
    let max_one = scan_dir(root, None, Some(1), &AtomicBool::new(false)).unwrap();
    assert!(max_one.truncated);
    assert_eq!(max_one.files.len(), 1);
}

#[test]
fn extract_docx_headings_lists_tables_footnotes_images_and_max_chars() {
    let dir = tempdir().unwrap();
    let styles = r#"<?xml version="1.0"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="H1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Bullet"><w:numPr><w:numId w:val="2"/></w:numPr></w:style>
</w:styles>"#;
    let doc = r#"<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Bullet"/></w:pPr><w:r><w:t>Item 02139</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>Secret</w:t></w:r><w:r><w:t>Visible</w:t></w:r><w:r><w:drawing><wp:docPr descr="Chart A"/></w:drawing></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body>
</w:document>"#;
    let footnotes = r#"<?xml version="1.0"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:type="separator"><w:p><w:r><w:t>---</w:t></w:r></w:p></w:footnote>
  <w:footnote w:id="1"><w:p><w:r><w:t>Note one</w:t></w:r></w:p></w:footnote>
</w:footnotes>"#;
    let zip = build_test_zip(&[
        TestZipEntry::deflate("word/document.xml", doc.as_bytes()),
        TestZipEntry::deflate("word/styles.xml", styles.as_bytes()),
        TestZipEntry::deflate("word/footnotes.xml", footnotes.as_bytes()),
    ]);
    let path = write_temp_file(dir.path(), "sample.docx", &zip);
    let res = extract_file(
        &path,
        "docx",
        &ExtractOptions::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    match res {
        ExtractResult::Ok { text, tokens } => {
            assert!(tokens.is_none());
            assert_eq!(
                text,
                "# Title\n- Item 02139\nVisible[image: Chart A]\nA | B\n## Footnotes\nNote one"
            );
        }
        other => panic!("expected Ok, got {other:?}"),
    }

    // .doc with ZIP magic parses as OOXML docx
    let doc_path = write_temp_file(dir.path(), "renamed.doc", &zip);
    let res = extract_file(
        &doc_path,
        "doc",
        &ExtractOptions::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(matches!(res, ExtractResult::Ok { .. }));
}

#[test]
fn extract_pptx_order_notes_comments_and_redaction_fail_closed() {
    let dir = tempdir().unwrap();
    let pres = r#"<?xml version="1.0"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst>
</p:presentation>"#;
    let pres_rels = r#"<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>"#;
    let slide1 = r#"<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Second </a:t></a:r><a:r><a:t>02139</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>"#;
    let slide2 = r#"<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>First slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>"#;
    let slide2_rels = r#"<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide2.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments/comment2.xml"/>
</Relationships>"#;
    let notes2 = r#"<?xml version="1.0"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Speaker note</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:notes>"#;
    let authors = r#"<?xml version="1.0"?>
<p:cmAuthorLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cmAuthor id="0" name="Alice"/>
</p:cmAuthorLst>"#;
    let comments2 = r#"<?xml version="1.0"?>
<p:cmLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cm authorId="0" dt="2026-01-01T00:00:00"><p:text>Looks good</p:text></p:cm>
</p:cmLst>"#;

    let zip = build_test_zip(&[
        TestZipEntry::deflate("ppt/presentation.xml", pres.as_bytes()),
        TestZipEntry::deflate("ppt/_rels/presentation.xml.rels", pres_rels.as_bytes()),
        TestZipEntry::deflate("ppt/slides/slide1.xml", slide1.as_bytes()),
        TestZipEntry::deflate("ppt/slides/slide2.xml", slide2.as_bytes()),
        TestZipEntry::deflate("ppt/slides/_rels/slide2.xml.rels", slide2_rels.as_bytes()),
        TestZipEntry::deflate("ppt/notesSlides/notesSlide2.xml", notes2.as_bytes()),
        TestZipEntry::deflate("ppt/commentAuthors.xml", authors.as_bytes()),
        TestZipEntry::deflate("ppt/comments/comment2.xml", comments2.as_bytes()),
    ]);
    let path = write_temp_file(dir.path(), "deck.pptx", &zip);
    let res = extract_file(
        &path,
        "pptx",
        &ExtractOptions::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    match res {
        ExtractResult::Ok { text, .. } => {
            assert_eq!(
                text,
                "## Slide 1\nFirst slide\n### Notes\nSpeaker note\n### Comments\n- Alice (2026-01-01T00:00:00): Looks good\n\n## Slide 2\nSecond 02139"
            );
        }
        other => panic!("expected Ok, got {other:?}"),
    }

    // Redaction trace via EXT URI, :redact, or runtime redactNamespaces must fail closed!
    let redacted_slide = r#"<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:rPr><a:extLst><a:ext uri="{9F1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D}"><x:mark/></a:ext></a:extLst></a:rPr><a:t>TOP SECRET</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>"#;
    let red_zip = build_test_zip(&[TestZipEntry::deflate(
        "ppt/slides/slide1.xml",
        redacted_slide.as_bytes(),
    )]);
    let red_path = write_temp_file(dir.path(), "redacted.pptx", &red_zip);
    let res = extract_file(
        &red_path,
        "pptx",
        &ExtractOptions::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        res,
        ExtractResult::Fallback {
            fallback_reason: FallbackReason::RedactionPresent
        }
    );

    let ns_slide = r#"<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:custom="https://example.invalid/custom-redact-ns">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>SECRET2</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>"#;
    let ns_zip = build_test_zip(&[TestZipEntry::deflate(
        "ppt/slides/slide1.xml",
        ns_slide.as_bytes(),
    )]);
    let ns_path = write_temp_file(dir.path(), "redacted_ns.pptx", &ns_zip);
    let opts = ExtractOptions {
        redact_namespaces: vec!["https://example.invalid/custom-redact-ns".to_owned()],
        ..Default::default()
    };
    let res = extract_file(&ns_path, "pptx", &opts, &AtomicBool::new(false)).unwrap();
    assert_eq!(
        res,
        ExtractResult::Fallback {
            fallback_reason: FallbackReason::RedactionPresent
        }
    );
}

#[test]
fn extract_xlsx_shared_strings_dates_formulas_and_empty_runs() {
    let dir = tempdir().unwrap();
    let wb = r#"<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#;
    let rels = r#"<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"#;
    let sst = r#"<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>02139</t></si>
</sst>"#;
    let styles = r#"<?xml version="1.0"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cellXfs count="2">
    <xf numFmtId="0"/>
    <xf numFmtId="14"/>
  </cellXfs>
</styleSheet>"#;
    let sheet1 = r#"<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" s="1"><v>45292</v></c>
      <c r="C1"><f t="shared" si="0">A1+1</f></c>
    </row>
    <row r="2">
      <c r="A2" t="inlineStr"><is><t>Start</t></is></c>
      <c r="C2"><f t="shared" si="0"/></c>
      <c r="M2" t="inlineStr"><is><t>Far</t></is></c>
    </row>
  </sheetData>
</worksheet>"#;
    let zip = build_test_zip(&[
        TestZipEntry::deflate("xl/workbook.xml", wb.as_bytes()),
        TestZipEntry::deflate("xl/_rels/workbook.xml.rels", rels.as_bytes()),
        TestZipEntry::deflate("xl/sharedStrings.xml", sst.as_bytes()),
        TestZipEntry::deflate("xl/styles.xml", styles.as_bytes()),
        TestZipEntry::deflate("xl/worksheets/sheet1.xml", sheet1.as_bytes()),
    ]);
    let path = write_temp_file(dir.path(), "book.xlsx", &zip);
    let res = extract_file(
        &path,
        "xlsx",
        &ExtractOptions::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    match res {
        ExtractResult::Ok { text, .. } => {
            assert_eq!(
                text,
                "# Sales\n02139 | 2024-01-01 | =A1+1\nStart |  | =A2+1 | (9 empty) | Far"
            );
        }
        other => panic!("expected Ok, got {other:?}"),
    }
}

#[test]
fn extract_odt_paragraphs_tables_notes_and_encryption_check() {
    let dir = tempdir().unwrap();
    let mimetype = b"application/vnd.oasis.opendocument.text";
    let content = r#"<?xml version="1.0"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">
  <office:body><office:text>
    <text:h>Heading</text:h>
    <text:p>Hello<text:s text:c="2"/>world<text:note><text:note-citation>1</text:note-citation><text:note-body><text:p>Foot</text:p></text:note-body></text:note></text:p>
    <table:table><table:table-row><table:table-cell><text:p>C1</text:p></table:table-cell><table:table-cell><text:p>C2</text:p></table:table-cell></table:table-row></table:table>
  </office:text></office:body>
</office:document-content>"#;
    let zip = build_test_zip(&[
        TestZipEntry::stored("mimetype", mimetype),
        TestZipEntry::deflate("content.xml", content.as_bytes()),
    ]);
    let path = write_temp_file(dir.path(), "doc.odt", &zip);
    let res = extract_file(
        &path,
        "odt",
        &ExtractOptions::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    match res {
        ExtractResult::Ok { text, .. } => {
            assert_eq!(text, "Heading\nHello  world1\nC1\tC2\n\n1 Foot");
        }
        other => panic!("expected Ok, got {other:?}"),
    }

    // Encrypted ODT
    let enc_manifest = r#"<?xml version="1.0"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">
  <manifest:file-entry manifest:full-path="content.xml"><manifest:encryption-data/></manifest:file-entry>
</manifest:manifest>"#;
    let enc_zip = build_test_zip(&[
        TestZipEntry::stored("mimetype", mimetype),
        TestZipEntry::deflate("META-INF/manifest.xml", enc_manifest.as_bytes()),
        TestZipEntry::deflate("content.xml", content.as_bytes()),
    ]);
    let enc_path = write_temp_file(dir.path(), "enc.odt", &enc_zip);
    let res = extract_file(
        &enc_path,
        "odt",
        &ExtractOptions::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(matches!(
        res,
        ExtractResult::Rejected {
            reject_code: RejectCode::PasswordProtected,
            ..
        }
    ));
}

#[test]
fn extract_epub_spine_html_and_drm_rejection() {
    let dir = tempdir().unwrap();
    let container = r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#;
    let opf = r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>"#;
    let ch1 = r#"<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Skip</title></head><body>
  <h1>Chapter 1</h1>
  <p>Hello <b>world</b></p>
  <table><tr><td>A</td><td>B</td></tr></table>
</body></html>"#;
    let zip = build_test_zip(&[
        TestZipEntry::deflate("META-INF/container.xml", container.as_bytes()),
        TestZipEntry::deflate("OEBPS/content.opf", opf.as_bytes()),
        TestZipEntry::deflate("OEBPS/ch1.xhtml", ch1.as_bytes()),
    ]);
    let path = write_temp_file(dir.path(), "book.epub", &zip);
    let res = extract_file(
        &path,
        "epub",
        &ExtractOptions::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    match res {
        ExtractResult::Ok { text, .. } => {
            assert_eq!(text, "# Chapter 1\n\nHello world\n\nA\tB");
        }
        other => panic!("expected Ok, got {other:?}"),
    }

    // DRM via rights.xml
    let drm_zip = build_test_zip(&[
        TestZipEntry::deflate("META-INF/container.xml", container.as_bytes()),
        TestZipEntry::deflate("META-INF/rights.xml", b"<rights/>"),
        TestZipEntry::deflate("OEBPS/content.opf", opf.as_bytes()),
        TestZipEntry::deflate("OEBPS/ch1.xhtml", ch1.as_bytes()),
    ]);
    let drm_path = write_temp_file(dir.path(), "drm.epub", &drm_zip);
    let res = extract_file(
        &drm_path,
        "epub",
        &ExtractOptions::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(matches!(
        res,
        ExtractResult::Rejected {
            reject_code: RejectCode::PasswordProtected,
            ..
        }
    ));
}

#[test]
fn extract_xmind_outline_legacy_and_encrypted() {
    let dir = tempdir().unwrap();
    let content = r#"[
  {
    "id": "s1",
    "title": "Plan",
    "rootTopic": {
      "id": "t1",
      "title": "Root",
      "children": {
        "attached": [
          {
            "id": "t2",
            "title": "Child",
            "labels": ["tag1", "tag2"],
            "href": "https://example.com/a b",
            "notes": { "plain": { "content": "Line 1\nLine 2\n" } }
          }
        ]
      }
    }
  }
]"#;
    let zip = build_test_zip(&[TestZipEntry::deflate("content.json", content.as_bytes())]);
    let path = write_temp_file(dir.path(), "map.xmind", &zip);
    let res = extract_file(
        &path,
        "xmind",
        &ExtractOptions::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    match res {
        ExtractResult::Ok { text, .. } => {
            assert_eq!(
                text,
                "# Plan\n\n- Root\n  - Child [tag1, tag2] <https://example.com/a%20b>\n    > Line 1\n    > Line 2\n"
            );
        }
        other => panic!("expected Ok, got {other:?}"),
    }

    // Legacy content.xml only -> corrupt
    let legacy_zip = build_test_zip(&[TestZipEntry::deflate("content.xml", b"<xmap/>")]);
    let legacy_path = write_temp_file(dir.path(), "legacy.xmind", &legacy_zip);
    assert!(matches!(
        extract_file(
            &legacy_path,
            "xmind",
            &ExtractOptions::default(),
            &AtomicBool::new(false)
        )
        .unwrap(),
        ExtractResult::Rejected {
            reject_code: RejectCode::Corrupt,
            ..
        }
    ));

    // Encrypted manifest.json -> password_protected
    let enc_manifest =
        r#"{"file-entries":{"content.json":{"encryption-data":{"algorithm-name":"AES"}}}}"#;
    let enc_zip = build_test_zip(&[
        TestZipEntry::deflate("content.json", b"encrypted"),
        TestZipEntry::deflate("manifest.json", enc_manifest.as_bytes()),
    ]);
    let enc_path = write_temp_file(dir.path(), "enc.xmind", &enc_zip);
    assert!(matches!(
        extract_file(
            &enc_path,
            "xmind",
            &ExtractOptions::default(),
            &AtomicBool::new(false)
        )
        .unwrap(),
        ExtractResult::Rejected {
            reject_code: RejectCode::PasswordProtected,
            ..
        }
    ));
}

#[test]
fn extract_plain_csv_utf32_magic_mismatch_and_unsupported_fallback() {
    let dir = tempdir().unwrap();

    // UTF-32LE BOM rejected
    let utf32_path = write_temp_file(
        dir.path(),
        "bad.csv",
        &[0xFF, 0xFE, 0x00, 0x00, b'a', 0, 0, 0],
    );
    assert!(matches!(
        extract_file(
            &utf32_path,
            "csv",
            &ExtractOptions::default(),
            &AtomicBool::new(false)
        )
        .unwrap(),
        ExtractResult::Rejected {
            reject_code: RejectCode::UnsupportedEncoding,
            ..
        }
    ));

    // UTF-8 CSV with tokenize=true
    let csv_path = write_temp_file(dir.path(), "data.csv", "이름,점수\n철수,100".as_bytes());
    let opts = ExtractOptions {
        tokenize: true,
        ..Default::default()
    };
    match extract_file(&csv_path, "csv", &opts, &AtomicBool::new(false)).unwrap() {
        ExtractResult::Ok { text, tokens } => {
            assert_eq!(text, "이름,점수\n철수,100");
            let tok = tokens.expect("tokens requested");
            assert_eq!(tok.bi, "이름 점수 철수 100");
            assert_eq!(tok.uni, "이 름 점 수 철 수 100");
        }
        other => panic!("expected Ok, got {other:?}"),
    }

    // Password-protected OOXML (OLE2 + UTF-16LE EncryptedPackage)
    let mut ole2 = vec![0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    for ch in "EncryptedPackage".encode_utf16() {
        ole2.extend_from_slice(&ch.to_le_bytes());
    }
    let pw_path = write_temp_file(dir.path(), "secret.docx", &ole2);
    assert!(matches!(
        extract_file(
            &pw_path,
            "docx",
            &ExtractOptions::default(),
            &AtomicBool::new(false)
        )
        .unwrap(),
        ExtractResult::Rejected {
            reject_code: RejectCode::PasswordProtected,
            ..
        }
    ));

    // Legacy OLE2 .doc -> fallback unsupported_format
    let legacy_doc = write_temp_file(dir.path(), "old.doc", &[0xD0, 0xCF, 0x11, 0xE0, 0, 0]);
    assert_eq!(
        extract_file(
            &legacy_doc,
            "doc",
            &ExtractOptions::default(),
            &AtomicBool::new(false)
        )
        .unwrap(),
        ExtractResult::Fallback {
            fallback_reason: FallbackReason::UnsupportedFormat
        }
    );

    // Unsupported format (md / html / pdf / hwp) -> fallback unsupported_format
    let md_path = write_temp_file(dir.path(), "note.md", b"# hi");
    assert_eq!(
        extract_file(
            &md_path,
            "md",
            &ExtractOptions::default(),
            &AtomicBool::new(false)
        )
        .unwrap(),
        ExtractResult::Fallback {
            fallback_reason: FallbackReason::UnsupportedFormat
        }
    );
}

#[test]
fn extract_docx_edge_cases_hidden_images_headers_image_only_and_max_chars() {
    let dir = tempdir().unwrap();

    // Image-only document notice
    let img_only_doc = r#"<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
  <w:body>
    <w:p><w:r><w:drawing><wp:docPr hidden="1" descr="ShouldNotAppear"/></w:drawing></w:r></w:p>
    <w:p><w:r><w:drawing><wp:docPr/></w:drawing></w:r></w:p>
  </w:body>
</w:document>"#;
    let zip = build_test_zip(&[TestZipEntry::deflate(
        "word/document.xml",
        img_only_doc.as_bytes(),
    )]);
    let path = write_temp_file(dir.path(), "imgonly.docx", &zip);
    match extract_file(
        &path,
        "docx",
        &ExtractOptions::default(),
        &AtomicBool::new(false),
    )
    .unwrap()
    {
        ExtractResult::Ok { text, .. } => {
            assert_eq!(text, "[image-only document: 2 images, no extractable text]");
        }
        other => panic!("expected Ok, got {other:?}"),
    }

    // Related header/footer/comments + maxChars early stop
    let body = r#"<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Line One</w:t></w:r></w:p>
    <w:p><w:r><w:t>Line Two</w:t></w:r></w:p>
  </w:body>
</w:document>"#;
    let rels = r#"<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
</Relationships>"#;
    let header1 = r#"<?xml version="1.0"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:t>Top Banner</w:t></w:r></w:p>
</w:hdr>"#;
    let zip2 = build_test_zip(&[
        TestZipEntry::deflate("word/document.xml", body.as_bytes()),
        TestZipEntry::deflate("word/_rels/document.xml.rels", rels.as_bytes()),
        TestZipEntry::deflate("word/header1.xml", header1.as_bytes()),
    ]);
    let p2 = write_temp_file(dir.path(), "hdr.docx", &zip2);
    match extract_file(
        &p2,
        "docx",
        &ExtractOptions::default(),
        &AtomicBool::new(false),
    )
    .unwrap()
    {
        ExtractResult::Ok { text, .. } => {
            assert_eq!(text, "Line One\nLine Two\n## Header\nTop Banner");
        }
        other => panic!("expected Ok, got {other:?}"),
    }
    let opts = ExtractOptions {
        max_chars: Some(9),
        ..Default::default()
    };
    match extract_file(&p2, "docx", &opts, &AtomicBool::new(false)).unwrap() {
        ExtractResult::Ok { text, .. } => assert_eq!(text, "Line One"),
        other => panic!("expected Ok, got {other:?}"),
    }
}

#[test]
fn extract_pptx_threaded_comments_picture_only_and_redact_in_notes_or_comments() {
    let dir = tempdir().unwrap();

    // Picture-only slide deck notice
    let pic_slide = r#"<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:pic/></p:spTree></p:cSld>
</p:sld>"#;
    let pic_zip = build_test_zip(&[TestZipEntry::deflate(
        "ppt/slides/slide1.xml",
        pic_slide.as_bytes(),
    )]);
    let pic_path = write_temp_file(dir.path(), "pics.pptx", &pic_zip);
    match extract_file(
        &pic_path,
        "pptx",
        &ExtractOptions::default(),
        &AtomicBool::new(false),
    )
    .unwrap()
    {
        ExtractResult::Ok { text, .. } => {
            assert!(text.starts_with("[No extractable text: none of the 1 slide carries text;"));
            assert!(text.contains("[picture-only slide: 1 image, no extractable text]"));
        }
        other => panic!("expected Ok, got {other:?}"),
    }

    // :redact inside notes must abort entire deck with zero text leaked
    let clean_slide = r#"<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Public</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>"#;
    let slide_rels = r#"<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
</Relationships>"#;
    let redacted_notes = r#"<?xml version="1.0"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:rPr><go:redact label="SSN"/></a:rPr><a:t>123-45-6789</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:notes>"#;
    let red_notes_zip = build_test_zip(&[
        TestZipEntry::deflate("ppt/slides/slide1.xml", clean_slide.as_bytes()),
        TestZipEntry::deflate("ppt/slides/_rels/slide1.xml.rels", slide_rels.as_bytes()),
        TestZipEntry::deflate("ppt/notesSlides/notesSlide1.xml", redacted_notes.as_bytes()),
    ]);
    let red_notes_path = write_temp_file(dir.path(), "rednotes.pptx", &red_notes_zip);
    assert_eq!(
        extract_file(
            &red_notes_path,
            "pptx",
            &ExtractOptions::default(),
            &AtomicBool::new(false)
        )
        .unwrap(),
        ExtractResult::Fallback {
            fallback_reason: FallbackReason::RedactionPresent
        }
    );

    // Threaded Office 365 comments with reply
    let cm_rels = r#"<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2018/10/relationships/comments" Target="../comments/comment1.xml"/>
</Relationships>"#;
    let authors = r#"<p188:authorLst xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main"><p188:author id="{A}" name="Bob"/></p188:authorLst>"#;
    let threaded = r#"<p188:cmLst xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p188:cm authorId="{A}" created="2026-02-01">
    <p188:txBody><a:p><a:r><a:t>Parent comment</a:t></a:r></a:p></p188:txBody>
    <p188:replyLst>
      <p188:reply authorId="{MISSING}"><p188:txBody><a:p><a:r><a:t>Reply text</a:t></a:r></a:p></p188:txBody></p188:reply>
    </p188:replyLst>
  </p188:cm>
</p188:cmLst>"#;
    let t_zip = build_test_zip(&[
        TestZipEntry::deflate("ppt/slides/slide1.xml", clean_slide.as_bytes()),
        TestZipEntry::deflate("ppt/slides/_rels/slide1.xml.rels", cm_rels.as_bytes()),
        TestZipEntry::deflate("ppt/authors.xml", authors.as_bytes()),
        TestZipEntry::deflate("ppt/comments/comment1.xml", threaded.as_bytes()),
    ]);
    let t_path = write_temp_file(dir.path(), "threaded.pptx", &t_zip);
    match extract_file(
        &t_path,
        "pptx",
        &ExtractOptions::default(),
        &AtomicBool::new(false),
    )
    .unwrap()
    {
        ExtractResult::Ok { text, .. } => {
            assert_eq!(
                text,
                "## Slide 1\nPublic\n### Comments\n- Bob (2026-02-01): Parent comment\n- Unknown author: Reply text"
            );
        }
        other => panic!("expected Ok, got {other:?}"),
    }
}

#[test]
fn extract_odt_textbox_table_custom_prefix_and_wrong_mimetype() {
    let dir = tempdir().unwrap();
    let mimetype = b"application/vnd.oasis.opendocument.text";
    let content = r#"<?xml version="1.0"?>
<o:document-content
  xmlns:o="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:t="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:tb="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:d="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0">
  <o:body><o:text>
    <t:p><d:frame><d:text-box><tb:table><tb:table-row><tb:table-cell><t:p>BoxA</t:p></tb:table-cell><tb:table-cell><t:p>BoxB</t:p></tb:table-cell></tb:table-row></tb:table></d:text-box></d:frame></t:p>
  </o:text></o:body>
</o:document-content>"#;
    let zip = build_test_zip(&[
        TestZipEntry::stored("mimetype", mimetype),
        TestZipEntry::deflate("content.xml", content.as_bytes()),
    ]);
    let path = write_temp_file(dir.path(), "hancom.odt", &zip);
    match extract_file(
        &path,
        "odt",
        &ExtractOptions::default(),
        &AtomicBool::new(false),
    )
    .unwrap()
    {
        ExtractResult::Ok { text, .. } => assert_eq!(text, "BoxA\tBoxB"),
        other => panic!("expected Ok, got {other:?}"),
    }

    // Wrong mimetype -> ContentMismatch
    let ods_zip = build_test_zip(&[
        TestZipEntry::stored(
            "mimetype",
            b"application/vnd.oasis.opendocument.spreadsheet",
        ),
        TestZipEntry::deflate("content.xml", content.as_bytes()),
    ]);
    let ods_path = write_temp_file(dir.path(), "wrong.odt", &ods_zip);
    assert!(matches!(
        extract_file(
            &ods_path,
            "odt",
            &ExtractOptions::default(),
            &AtomicBool::new(false)
        )
        .unwrap(),
        ExtractResult::Rejected {
            reject_code: RejectCode::ContentMismatch,
            ..
        }
    ));
}

#[test]
fn extract_epub_html_fallback_font_obfuscation_and_invalid_encoding_chapter() {
    let dir = tempdir().unwrap();
    let container = r#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#;
    let opf = r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>"#;
    // Allowed font obfuscation only (NOT DRM)
    let font_enc = r#"<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/></enc:EncryptedData>
</encryption>"#;
    // Malformed XML (unclosed <p>, bare <br>, <script> skipped)
    let c1_html = b"<html><body><h2>Part&nbsp;1</h2><p>First<br>Second<p>Third<script>bad()</script></body></html>";
    let c2_invalid_utf8 = &[0xFF, 0xFE, 0x00]; // odd-length invalid UTF-16LE

    let zip = build_test_zip(&[
        TestZipEntry::deflate("META-INF/container.xml", container.as_bytes()),
        TestZipEntry::deflate("META-INF/encryption.xml", font_enc.as_bytes()),
        TestZipEntry::deflate("content.opf", opf.as_bytes()),
        TestZipEntry::deflate("c1.xhtml", c1_html),
        TestZipEntry::deflate("c2.xhtml", c2_invalid_utf8),
    ]);
    let path = write_temp_file(dir.path(), "mixed.epub", &zip);
    match extract_file(
        &path,
        "epub",
        &ExtractOptions::default(),
        &AtomicBool::new(false),
    )
    .unwrap()
    {
        ExtractResult::Ok { text, .. } => {
            assert_eq!(
                text,
                "## Part\u{00A0}1\n\nFirst\nSecond\n\nThird\n\n[Chapter 2 (c2.xhtml) left out: its bytes are not valid utf-16le text]"
            );
        }
        other => panic!("expected Ok, got {other:?}"),
    }

    // 0 readable chapters -> Corrupt
    let bad_opf = r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c2"/></spine>
</package>"#;
    let zero_zip = build_test_zip(&[
        TestZipEntry::deflate("META-INF/container.xml", container.as_bytes()),
        TestZipEntry::deflate("content.opf", bad_opf.as_bytes()),
        TestZipEntry::deflate("c2.xhtml", &[0x80, 0x81, 0x82]),
    ]);
    let zero_path = write_temp_file(dir.path(), "zero.epub", &zero_zip);
    assert!(matches!(
        extract_file(
            &zero_path,
            "epub",
            &ExtractOptions::default(),
            &AtomicBool::new(false)
        )
        .unwrap(),
        ExtractResult::Rejected {
            reject_code: RejectCode::Corrupt,
            ..
        }
    ));
}

#[test]
fn extract_csv_euc_kr_and_utf16_bom() {
    let dir = tempdir().unwrap();

    // Korean prose in EUC-KR (CP949)
    let korean_text =
        "이름,부서,비고\n대한민국은 아름다운 나라입니다. 오늘 회의록을 작성하고 있습니다.";
    let (euc_kr_bytes, _, _) = encoding_rs::EUC_KR.encode(korean_text);
    let kr_path = write_temp_file(dir.path(), "kr.csv", &euc_kr_bytes);
    match extract_file(
        &kr_path,
        "csv",
        &ExtractOptions::default(),
        &AtomicBool::new(false),
    )
    .unwrap()
    {
        ExtractResult::Ok { text, .. } => assert_eq!(text, korean_text),
        other => panic!("expected Ok, got {other:?}"),
    }

    // UTF-16BE BOM in .xml
    let mut utf16be = vec![0xFE, 0xFF];
    for u in "<a/>".encode_utf16() {
        utf16be.extend_from_slice(&u.to_be_bytes());
    }
    let xml_path = write_temp_file(dir.path(), "be.xml", &utf16be);
    match extract_file(
        &xml_path,
        "xml",
        &ExtractOptions::default(),
        &AtomicBool::new(false),
    )
    .unwrap()
    {
        ExtractResult::Ok { text, .. } => assert_eq!(text, "<a/>"),
        other => panic!("expected Ok, got {other:?}"),
    }

    // UTF-32BE BOM rejected
    let utf32be = write_temp_file(
        dir.path(),
        "u32.py",
        &[0x00, 0x00, 0xFE, 0xFF, 0, 0, 0, b'x'],
    );
    assert!(matches!(
        extract_file(
            &utf32be,
            "py",
            &ExtractOptions::default(),
            &AtomicBool::new(false)
        )
        .unwrap(),
        ExtractResult::Rejected {
            reject_code: RejectCode::UnsupportedEncoding,
            ..
        }
    ));
}
