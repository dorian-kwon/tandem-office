use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use serde_json::{Value, json};
use tempfile::tempdir;

fn sidecar_bin() -> &'static str {
    env!("CARGO_BIN_EXE_ieum-parse-sidecar")
}

#[test]
fn sidecar_json_rpc_commands_concurrency_cancel_and_shutdown() {
    let dir = tempdir().unwrap();
    let csv_path = dir.path().join("sample.csv");
    fs::write(&csv_path, "이름,코드\n김철수,02139\n").unwrap();
    let log_path = dir.path().join("app.log");
    fs::write(&log_path, b"hello \xe9 world").unwrap(); // Windows-1252 fallback
    let md_path = dir.path().join("doc.md");
    fs::write(&md_path, "# Markdown\n").unwrap();

    let mut child = Command::new(sidecar_bin())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn ieum-parse-sidecar");

    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();

    // Send multiple requests concurrently, including invalid JSON, wrong version,
    // extract_file, scan_dir, tokenize_text, cancel, and shutdown.
    let requests = vec![
        "not-valid-json".to_owned(),
        json!({ "version": 99, "requestId": "bad-ver", "command": "tokenize_text", "text": "a" })
            .to_string(),
        json!({
            "version": 1,
            "requestId": "req-csv",
            "command": "extract_file",
            "path": csv_path,
            "ext": "csv",
            "tokenize": true,
            "maxBodyChars": 100
        })
        .to_string(),
        json!({
            "version": 1,
            "requestId": "req-log",
            "command": "extract_file",
            "path": log_path,
            "ext": "log"
        })
        .to_string(),
        json!({
            "version": 1,
            "requestId": "req-md",
            "command": "extract_file",
            "path": md_path,
            "ext": "md"
        })
        .to_string(),
        json!({
            "version": 1,
            "requestId": "req-scan",
            "command": "scan_dir",
            "root": dir.path()
        })
        .to_string(),
        json!({
            "version": 1,
            "requestId": "req-tok",
            "command": "tokenize_text",
            "text": "ＡＢＣ 한글검색"
        })
        .to_string(),
        json!({
            "version": 1,
            "requestId": "req-cancel",
            "command": "cancel",
            "targetRequestId": "nonexistent-id"
        })
        .to_string(),
    ];

    for line in &requests {
        writeln!(stdin, "{line}").unwrap();
    }
    stdin.flush().unwrap();

    let mut reader = BufReader::new(stdout);
    let mut by_id: HashMap<String, Value> = HashMap::new();
    let mut saw_invalid_json = false;

    for _ in 0..requests.len() {
        let mut line = String::new();
        let n = reader.read_line(&mut line).unwrap();
        assert!(n > 0, "unexpected EOF before all responses arrived");
        let val: Value = serde_json::from_str(&line).expect("stdout must only contain JSON lines");
        assert_eq!(val["version"], 1);
        let id = val["requestId"].as_str().unwrap().to_owned();
        if id.is_empty() {
            assert_eq!(val["ok"], false);
            assert_eq!(val["error"]["code"], "invalid_json");
            saw_invalid_json = true;
        } else {
            by_id.insert(id, val);
        }
    }

    assert!(saw_invalid_json);
    assert_eq!(by_id["bad-ver"]["ok"], false);
    assert_eq!(by_id["bad-ver"]["error"]["code"], "unsupported_version");

    // CSV extraction + tokenization
    let csv_res = &by_id["req-csv"];
    assert_eq!(csv_res["ok"], true);
    assert_eq!(csv_res["result"]["status"], "ok");
    assert_eq!(csv_res["result"]["text"], "이름,코드\n김철수,02139\n");
    assert_eq!(
        csv_res["result"]["tokens"]["bi"],
        "이름 코드 김철 철수 02139"
    );
    assert_eq!(
        csv_res["result"]["tokens"]["uni"],
        "이 름 코 드 김 철 수 02139"
    );

    // Windows-1252 log fallback
    assert_eq!(by_id["req-log"]["result"]["status"], "ok");
    assert_eq!(by_id["req-log"]["result"]["text"], "hello \u{00e9} world");
    assert!(by_id["req-log"]["result"].get("tokens").is_none());

    // Markdown fallback with no text/tokens leaked
    assert_eq!(by_id["req-md"]["result"]["status"], "fallback");
    assert_eq!(
        by_id["req-md"]["result"]["fallbackReason"],
        "unsupported_format"
    );
    assert!(by_id["req-md"]["result"].get("text").is_none());
    assert!(by_id["req-md"]["result"].get("tokens").is_none());

    // scan_dir finds sample.csv and doc.md (app.log is not in TREE_FILE_EXTENSIONS)
    assert_eq!(by_id["req-scan"]["ok"], true);
    assert_eq!(by_id["req-scan"]["result"]["truncated"], false);
    assert_eq!(
        by_id["req-scan"]["result"]["files"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    // tokenize_text
    assert_eq!(by_id["req-tok"]["result"]["bi"], "abc 한글 글검 검색");
    assert_eq!(by_id["req-tok"]["result"]["uni"], "abc 한 글 검 색");

    // cancel of unknown request
    assert_eq!(by_id["req-cancel"]["ok"], true);
    assert_eq!(by_id["req-cancel"]["result"]["cancelled"], false);

    // Send shutdown and verify response + clean exit code 0
    writeln!(
        stdin,
        "{}",
        json!({ "version": 1, "requestId": "req-shut", "command": "shutdown" })
    )
    .unwrap();
    stdin.flush().unwrap();

    let mut shut_line = String::new();
    reader.read_line(&mut shut_line).unwrap();
    let shut_val: Value = serde_json::from_str(&shut_line).unwrap();
    assert_eq!(shut_val["ok"], true);
    assert_eq!(shut_val["result"]["shutdown"], true);

    drop(stdin);
    let status = child.wait().unwrap();
    assert!(
        status.success(),
        "sidecar did not exit 0 on shutdown: {status}"
    );
}

#[test]
fn sidecar_exits_cleanly_on_stdin_eof() {
    let mut child = Command::new(sidecar_bin())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn ieum-parse-sidecar");

    // Close stdin immediately without sending shutdown
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "sidecar did not exit 0 on EOF");
    assert!(
        output.stdout.is_empty(),
        "unexpected stdout output on bare EOF"
    );
}
