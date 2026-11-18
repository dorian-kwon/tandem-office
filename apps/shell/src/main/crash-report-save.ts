import { newestWatchdogDiagnostic } from './watchdog-diagnostics'
import { join } from 'node:path'
import { createI18n, defineStrings, type Lang } from '@genoffice/i18n'
import { buildCrashReport, reportFileName, type CrashReportInput } from './crash-report'

/**
 * The Help menu's "Save problem report…". The file holds the app's own records (see
 * crash-report.ts) and is written only where the person chooses; the app sends nothing, and
 * what the file holds is on screen before anything is asked.
 */

const zh = {
  menuLabel: '保存问题报告…',
  dialogTitle: '保存问题报告',
  dialogBody:
    '将保存一个文本文件，内容是应用自己的记录：版本、系统、运行时长、打开的编辑器、最近的操作，以及资源使用、崩溃、保存失败和更新记录。其中不含文档内容、文件名或文件夹路径。不会发送任何内容，是否发送由你决定。',
  btnSave: '保存…',
  btnCancel: '取消',
  savedBody: '报告已保存。报告问题时请一并发送这个文件。',
  btnShow: '在文件夹中显示',
  btnClose: '关闭',
  failedBody: '无法保存报告。',
}

type Keys = Record<keyof typeof zh, string>

export const CRASH_REPORT_STRINGS = defineStrings({
  zh,
  en: {
    menuLabel: 'Save problem report…',
    dialogTitle: 'Save problem report',
    dialogBody:
      "This saves a text file with the app's own records: version, system, how long the app ran, which editors were open, the last actions, and resource-use, crash, save-failure and update records. It has no document text, file names or folder paths. Nothing is sent; you choose whether to send the file.",
    btnSave: 'Save…',
    btnCancel: 'Cancel',
    savedBody: 'The report is saved. Send this file when you report the problem.',
    btnShow: 'Show in folder',
    btnClose: 'Close',
    failedBody: 'The report could not be saved.',
  } satisfies Keys,
  ja: {
    menuLabel: '問題レポートを保存…',
    dialogTitle: '問題レポートを保存',
    dialogBody:
      'アプリ自身の記録を書いたテキストファイルを保存します。内容は、バージョン、システム、起動していた時間、開いていたエディター、直前の操作、リソース使用量・クラッシュ・保存失敗・更新の記録です。文書の内容、ファイル名、フォルダーのパスは含まれません。何も送信されません。送るかどうかはあなたが決めます。',
    btnSave: '保存…',
    btnCancel: 'キャンセル',
    savedBody: 'レポートを保存しました。問題を報告するときに、このファイルを送ってください。',
    btnShow: 'フォルダーで表示',
    btnClose: '閉じる',
    failedBody: 'レポートを保存できませんでした。',
  } satisfies Keys,
  ko: {
    menuLabel: '문제 보고서 저장…',
    dialogTitle: '문제 보고서 저장',
    dialogBody:
      '앱이 스스로 남긴 기록을 담은 텍스트 파일을 저장합니다. 버전, 시스템, 앱이 켜져 있던 시간, 열려 있던 편집기, 마지막 동작, 자원 사용·크래시·저장 실패·업데이트 기록이 들어 있습니다. 문서 내용, 파일 이름, 폴더 경로는 들어 있지 않습니다. 아무것도 전송되지 않으며, 보낼지는 직접 정합니다.',
    btnSave: '저장…',
    btnCancel: '취소',
    savedBody: '보고서를 저장했습니다. 문제를 알릴 때 이 파일을 함께 보내 주세요.',
    btnShow: '폴더에서 보기',
    btnClose: '닫기',
    failedBody: '보고서를 저장하지 못했습니다.',
  } satisfies Keys,
  fr: {
    menuLabel: 'Enregistrer un rapport de problème…',
    dialogTitle: 'Enregistrer un rapport de problème',
    dialogBody:
      'Un fichier texte va être enregistré avec les propres relevés de l’application : version, système, durée d’exécution, éditeurs ouverts, dernières actions, ainsi que les relevés d’utilisation des ressources et de plantages, d’échecs d’enregistrement et de mises à jour. Il ne contient ni texte de document, ni noms de fichiers, ni chemins de dossiers. Rien n’est envoyé ; c’est vous qui décidez d’envoyer le fichier.',
    btnSave: 'Enregistrer…',
    btnCancel: 'Annuler',
    savedBody: 'Le rapport est enregistré. Joignez ce fichier quand vous signalez le problème.',
    btnShow: 'Afficher dans le dossier',
    btnClose: 'Fermer',
    failedBody: 'Le rapport n’a pas pu être enregistré.',
  } satisfies Keys,
  de: {
    menuLabel: 'Problembericht speichern…',
    dialogTitle: 'Problembericht speichern',
    dialogBody:
      'Es wird eine Textdatei mit den eigenen Aufzeichnungen der App gespeichert: Version, System, Laufzeit, geöffnete Editoren, letzte Aktionen sowie die Aufzeichnungen zur Ressourcennutzung und zu Abstürzen, Speicherfehlern und Updates. Sie enthält keinen Dokumenttext, keine Dateinamen und keine Ordnerpfade. Es wird nichts gesendet; ob Sie die Datei senden, entscheiden Sie.',
    btnSave: 'Speichern…',
    btnCancel: 'Abbrechen',
    savedBody:
      'Der Bericht ist gespeichert. Senden Sie diese Datei mit, wenn Sie das Problem melden.',
    btnShow: 'Im Ordner anzeigen',
    btnClose: 'Schließen',
    failedBody: 'Der Bericht konnte nicht gespeichert werden.',
  } satisfies Keys,
  es: {
    menuLabel: 'Guardar informe del problema…',
    dialogTitle: 'Guardar informe del problema',
    dialogBody:
      'Se guardará un archivo de texto con los registros de la propia aplicación: versión, sistema, tiempo en ejecución, editores abiertos, últimas acciones y los registros de uso de recursos, bloqueos, errores al guardar y actualizaciones. No contiene texto de documentos, nombres de archivo ni rutas de carpetas. No se envía nada; usted decide si envía el archivo.',
    btnSave: 'Guardar…',
    btnCancel: 'Cancelar',
    savedBody: 'El informe se ha guardado. Envíe este archivo cuando comunique el problema.',
    btnShow: 'Mostrar en la carpeta',
    btnClose: 'Cerrar',
    failedBody: 'No se pudo guardar el informe.',
  } satisfies Keys,
  th: {
    menuLabel: 'บันทึกรายงานปัญหา…',
    dialogTitle: 'บันทึกรายงานปัญหา',
    dialogBody:
      'จะบันทึกไฟล์ข้อความที่มีบันทึกของแอปเอง ได้แก่ เวอร์ชัน ระบบ ระยะเวลาที่แอปทำงาน ตัวแก้ไขที่เปิดอยู่ การกระทำล่าสุด และบันทึกการใช้ทรัพยากร การแครช ความล้มเหลวในการบันทึก และการอัปเดต ไฟล์นี้ไม่มีเนื้อหาเอกสาร ชื่อไฟล์ หรือพาธโฟลเดอร์ ไม่มีการส่งข้อมูลใด ๆ คุณเป็นผู้ตัดสินใจว่าจะส่งไฟล์หรือไม่',
    btnSave: 'บันทึก…',
    btnCancel: 'ยกเลิก',
    savedBody: 'บันทึกรายงานแล้ว โปรดแนบไฟล์นี้เมื่อแจ้งปัญหา',
    btnShow: 'แสดงในโฟลเดอร์',
    btnClose: 'ปิด',
    failedBody: 'ไม่สามารถบันทึกรายงานได้',
  } satisfies Keys,
  id: {
    menuLabel: 'Simpan laporan masalah…',
    dialogTitle: 'Simpan laporan masalah',
    dialogBody:
      'Sebuah berkas teks akan disimpan berisi catatan aplikasi sendiri: versi, sistem, lama aplikasi berjalan, editor yang terbuka, tindakan terakhir, serta catatan penggunaan sumber daya, crash, kegagalan simpan, dan pembaruan. Berkas ini tidak berisi teks dokumen, nama berkas, atau jalur folder. Tidak ada yang dikirim; Anda sendiri yang memutuskan apakah berkas dikirim.',
    btnSave: 'Simpan…',
    btnCancel: 'Batal',
    savedBody: 'Laporan sudah disimpan. Kirim berkas ini saat Anda melaporkan masalah.',
    btnShow: 'Tampilkan di folder',
    btnClose: 'Tutup',
    failedBody: 'Laporan tidak dapat disimpan.',
  } satisfies Keys,
  ru: {
    menuLabel: 'Сохранить отчёт о проблеме…',
    dialogTitle: 'Сохранить отчёт о проблеме',
    dialogBody:
      'Будет сохранён текстовый файл с собственными записями приложения: версия, система, время работы, открытые редакторы, последние действия, а также записи об использовании ресурсов, сбоях, ошибках сохранения и обновлениях. В нём нет текста документов, имён файлов и путей к папкам. Ничего не отправляется; отправлять ли файл, решаете вы.',
    btnSave: 'Сохранить…',
    btnCancel: 'Отмена',
    savedBody: 'Отчёт сохранён. Приложите этот файл, когда будете сообщать о проблеме.',
    btnShow: 'Показать в папке',
    btnClose: 'Закрыть',
    failedBody: 'Не удалось сохранить отчёт.',
  } satisfies Keys,
  ar: {
    menuLabel: 'حفظ تقرير المشكلة…',
    dialogTitle: 'حفظ تقرير المشكلة',
    dialogBody:
      'سيتم حفظ ملف نصي يحتوي على سجلات التطبيق نفسه: الإصدار والنظام ومدة التشغيل والمحررات المفتوحة وآخر الإجراءات، إضافة إلى سجلات استخدام الموارد والأعطال وإخفاقات الحفظ والتحديثات. لا يحتوي على نص المستندات أو أسماء الملفات أو مسارات المجلدات. لا يُرسل أي شيء، وأنت من يقرر إرسال الملف.',
    btnSave: 'حفظ…',
    btnCancel: 'إلغاء',
    savedBody: 'تم حفظ التقرير. أرسل هذا الملف عند الإبلاغ عن المشكلة.',
    btnShow: 'إظهار في المجلد',
    btnClose: 'إغلاق',
    failedBody: 'تعذّر حفظ التقرير.',
  } satisfies Keys,
  pt: {
    menuLabel: 'Salvar relatório do problema…',
    dialogTitle: 'Salvar relatório do problema',
    dialogBody:
      'Será salvo um arquivo de texto com os registros do próprio aplicativo: versão, sistema, tempo de execução, editores abertos, últimas ações e os registros de uso de recursos, falhas, erros ao salvar e atualizações. Ele não contém texto de documentos, nomes de arquivos nem caminhos de pastas. Nada é enviado; você decide se envia o arquivo.',
    btnSave: 'Salvar…',
    btnCancel: 'Cancelar',
    savedBody: 'O relatório foi salvo. Envie este arquivo ao comunicar o problema.',
    btnShow: 'Mostrar na pasta',
    btnClose: 'Fechar',
    failedBody: 'Não foi possível salvar o relatório.',
  } satisfies Keys,
  it: {
    menuLabel: 'Salva rapporto del problema…',
    dialogTitle: 'Salva rapporto del problema',
    dialogBody:
      'Verrà salvato un file di testo con i registri dell’app stessa: versione, sistema, tempo di esecuzione, editor aperti, ultime azioni e i registri di utilizzo delle risorse, arresti anomali, errori di salvataggio e aggiornamenti. Non contiene testo dei documenti, nomi di file o percorsi di cartelle. Non viene inviato nulla; sei tu a decidere se inviare il file.',
    btnSave: 'Salva…',
    btnCancel: 'Annulla',
    savedBody: 'Il rapporto è stato salvato. Invia questo file quando segnali il problema.',
    btnShow: 'Mostra nella cartella',
    btnClose: 'Chiudi',
    failedBody: 'Impossibile salvare il rapporto.',
  } satisfies Keys,
  pl: {
    menuLabel: 'Zapisz raport o problemie…',
    dialogTitle: 'Zapisz raport o problemie',
    dialogBody:
      'Zostanie zapisany plik tekstowy z własnymi zapisami aplikacji: wersja, system, czas działania, otwarte edytory, ostatnie czynności oraz zapisy wykorzystania zasobów, awarii, błędów zapisu i aktualizacji. Nie zawiera tekstu dokumentów, nazw plików ani ścieżek folderów. Nic nie jest wysyłane; o wysłaniu pliku decydujesz Ty.',
    btnSave: 'Zapisz…',
    btnCancel: 'Anuluj',
    savedBody: 'Raport został zapisany. Dołącz ten plik, zgłaszając problem.',
    btnShow: 'Pokaż w folderze',
    btnClose: 'Zamknij',
    failedBody: 'Nie udało się zapisać raportu.',
  } satisfies Keys,
  cs: {
    menuLabel: 'Uložit zprávu o problému…',
    dialogTitle: 'Uložit zprávu o problému',
    dialogBody:
      'Uloží se textový soubor s vlastními záznamy aplikace: verze, systém, doba běhu, otevřené editory, poslední akce a záznamy o využití prostředků, pádech, chybách ukládání a aktualizacích. Neobsahuje text dokumentů, názvy souborů ani cesty ke složkám. Nic se neodesílá; zda soubor odešlete, rozhodujete vy.',
    btnSave: 'Uložit…',
    btnCancel: 'Zrušit',
    savedBody: 'Zpráva byla uložena. Tento soubor přiložte, když problém nahlásíte.',
    btnShow: 'Zobrazit ve složce',
    btnClose: 'Zavřít',
    failedBody: 'Zprávu se nepodařilo uložit.',
  } satisfies Keys,
  nl: {
    menuLabel: 'Probleemrapport opslaan…',
    dialogTitle: 'Probleemrapport opslaan',
    dialogBody:
      'Er wordt een tekstbestand opgeslagen met de eigen gegevens van de app: versie, systeem, looptijd, geopende editors, laatste acties en de gegevens over brongebruik, crashes, opslagfouten en updates. Het bevat geen documenttekst, bestandsnamen of mappaden. Er wordt niets verzonden; u beslist zelf of u het bestand verstuurt.',
    btnSave: 'Opslaan…',
    btnCancel: 'Annuleren',
    savedBody: 'Het rapport is opgeslagen. Stuur dit bestand mee wanneer u het probleem meldt.',
    btnShow: 'Tonen in map',
    btnClose: 'Sluiten',
    failedBody: 'Het rapport kon niet worden opgeslagen.',
  } satisfies Keys,
  ms: {
    menuLabel: 'Simpan laporan masalah…',
    dialogTitle: 'Simpan laporan masalah',
    dialogBody:
      'Fail teks akan disimpan yang mengandungi rekod aplikasi itu sendiri: versi, sistem, tempoh aplikasi berjalan, editor yang dibuka, tindakan terakhir, serta rekod penggunaan sumber, ranap, kegagalan menyimpan dan kemas kini. Fail ini tidak mengandungi teks dokumen, nama fail atau laluan folder. Tiada apa-apa dihantar; anda sendiri yang memutuskan sama ada fail itu dihantar.',
    btnSave: 'Simpan…',
    btnCancel: 'Batal',
    savedBody: 'Laporan telah disimpan. Hantar fail ini apabila anda melaporkan masalah.',
    btnShow: 'Tunjukkan dalam folder',
    btnClose: 'Tutup',
    failedBody: 'Laporan tidak dapat disimpan.',
  } satisfies Keys,
  he: {
    menuLabel: 'שמירת דוח בעיה…',
    dialogTitle: 'שמירת דוח בעיה',
    dialogBody:
      'יישמר קובץ טקסט עם הרישומים של האפליקציה עצמה: גרסה, מערכת, משך ההפעלה, עורכים פתוחים, פעולות אחרונות, ורישומי שימוש במשאבים, קריסות, כשלי שמירה ועדכונים. הוא אינו כולל תוכן מסמכים, שמות קבצים או נתיבי תיקיות. דבר אינו נשלח; ההחלטה אם לשלוח את הקובץ בידיים שלך.',
    btnSave: 'שמירה…',
    btnCancel: 'ביטול',
    savedBody: 'הדוח נשמר. צרפו את הקובץ הזה כשאתם מדווחים על הבעיה.',
    btnShow: 'הצגה בתיקייה',
    btnClose: 'סגירה',
    failedBody: 'לא ניתן היה לשמור את הדוח.',
  } satisfies Keys,
  hi: {
    menuLabel: 'समस्या रिपोर्ट सहेजें…',
    dialogTitle: 'समस्या रिपोर्ट सहेजें',
    dialogBody:
      'ऐप के अपने रिकॉर्ड वाली एक टेक्स्ट फ़ाइल सहेजी जाएगी: संस्करण, सिस्टम, ऐप कितनी देर चला, खुले संपादक, आख़िरी क्रियाएँ, और संसाधन उपयोग, क्रैश, सहेजने की विफलता व अपडेट के रिकॉर्ड। इसमें दस्तावेज़ का पाठ, फ़ाइल के नाम या फ़ोल्डर के पथ नहीं होते। कुछ भी भेजा नहीं जाता; फ़ाइल भेजनी है या नहीं, यह आप तय करते हैं।',
    btnSave: 'सहेजें…',
    btnCancel: 'रद्द करें',
    savedBody: 'रिपोर्ट सहेज ली गई। समस्या बताते समय यह फ़ाइल साथ भेजें।',
    btnShow: 'फ़ोल्डर में दिखाएँ',
    btnClose: 'बंद करें',
    failedBody: 'रिपोर्ट सहेजी नहीं जा सकी।',
  } satisfies Keys,
  'zh-TW': {
    menuLabel: '儲存問題報告…',
    dialogTitle: '儲存問題報告',
    dialogBody:
      '將儲存一個文字檔，內容是應用程式自己的紀錄：版本、系統、執行時間、開啟的編輯器、最近的操作，以及資源使用、當機、儲存失敗和更新紀錄。其中不含文件內容、檔名或資料夾路徑。不會傳送任何內容，是否傳送由你決定。',
    btnSave: '儲存…',
    btnCancel: '取消',
    savedBody: '報告已儲存。回報問題時請一併傳送這個檔案。',
    btnShow: '在資料夾中顯示',
    btnClose: '關閉',
    failedBody: '無法儲存報告。',
  } satisfies Keys,
  vi: {
    menuLabel: 'Lưu báo cáo sự cố…',
    dialogTitle: 'Lưu báo cáo sự cố',
    dialogBody:
      'Sẽ lưu một tệp văn bản chứa các bản ghi của chính ứng dụng: phiên bản, hệ thống, thời gian ứng dụng đã chạy, các trình soạn thảo đang mở, những thao tác gần nhất, cùng bản ghi sử dụng tài nguyên, sự cố, lỗi lưu và cập nhật. Tệp không chứa nội dung tài liệu, tên tệp hay đường dẫn thư mục. Không có gì được gửi đi; bạn tự quyết định có gửi tệp hay không.',
    btnSave: 'Lưu…',
    btnCancel: 'Hủy',
    savedBody: 'Đã lưu báo cáo. Hãy gửi kèm tệp này khi báo cáo sự cố.',
    btnShow: 'Hiện trong thư mục',
    btnClose: 'Đóng',
    failedBody: 'Không thể lưu báo cáo.',
  } satisfies Keys,
})

export const crashReportText = createI18n(CRASH_REPORT_STRINGS)

export type SaveCrashReportResult = 'saved' | 'cancelled' | 'failed'

export interface SaveCrashReportDeps {
  lang: Lang
  downloadsDir: string
  userDataDir?: string
  /** the report's records, gathered when the person has agreed to save */
  input: () => CrashReportInput
  showMessageBox: (options: {
    type: 'info' | 'error'
    title: string
    message: string
    detail?: string
    buttons: string[]
    defaultId: number
    cancelId: number
    noLink: boolean
  }) => Promise<{ response: number }>
  showSaveDialog: (options: {
    title: string
    defaultPath: string
    filters: Array<{ name: string; extensions: string[] }>
  }) => Promise<{ canceled: boolean; filePath?: string }>
  showItemInFolder: (path: string) => void
  writeFile: (path: string, text: string) => Promise<void>
}

/**
 * Say what the file holds, ask where to save it, write it, and say where it went. Returns
 * 'cancelled' when the person stops at either question and 'failed' when it could not be written.
 */
export async function saveCrashReport(deps: SaveCrashReportDeps): Promise<SaveCrashReportResult> {
  const t = (key: keyof typeof zh): string => crashReportText(deps.lang, key)
  const intro = await deps.showMessageBox({
    type: 'info',
    title: t('dialogTitle'),
    message: t('dialogTitle'),
    detail: t('dialogBody'),
    buttons: [t('btnSave'), t('btnCancel')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (intro.response !== 0) return 'cancelled'

  let input: CrashReportInput
  try {
    input = deps.input()
    if (deps.userDataDir)
      input = { ...input, watchdogLog: newestWatchdogDiagnostic(deps.userDataDir) }
  } catch {
    await failedBox(deps, t)
    return 'failed'
  }
  const chosen = await deps.showSaveDialog({
    title: t('dialogTitle'),
    defaultPath: join(deps.downloadsDir, reportFileName(input.now)),
    filters: [{ name: 'Text', extensions: ['txt'] }],
  })
  if (chosen.canceled || !chosen.filePath) return 'cancelled'

  try {
    await deps.writeFile(chosen.filePath, buildCrashReport(input))
  } catch {
    await failedBox(deps, t)
    return 'failed'
  }
  const done = await deps.showMessageBox({
    type: 'info',
    title: t('dialogTitle'),
    message: t('savedBody'),
    buttons: [t('btnShow'), t('btnClose')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  if (done.response === 0) deps.showItemInFolder(chosen.filePath)
  return 'saved'
}

async function failedBox(
  deps: SaveCrashReportDeps,
  t: (key: keyof typeof zh) => string,
): Promise<void> {
  await deps.showMessageBox({
    type: 'error',
    title: t('dialogTitle'),
    message: t('failedBody'),
    buttons: [t('btnClose')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
}
