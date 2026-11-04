import type { Lang } from '@genoffice/i18n'

/** The persistent run status line above the AI composer (every editor shares it). */
export interface AiRunStatusStrings {
  /** running, nothing more specific known */
  working: string
  /** running, the model is streaming its reply */
  writing: string
  /** running a tool; {tool} is a readable tool name */
  tool: string
  /** a tool asked the person to act, the AI is paused */
  waiting: string
  done: string
  /** the person pressed stop */
  stopped: string
  /** the run ended on an error; the reason is in the chat */
  error: string
}

export const AI_RUN_STATUS_STRINGS: Record<Lang, AiRunStatusStrings> = {
  zh: {
    working: '正在处理',
    writing: '正在撰写回复',
    tool: '正在运行工具：{tool}',
    waiting: '等待您在弹出窗口中确认',
    done: '已完成',
    stopped: '已停止',
    error: '因出错而停止，详情见对话',
  },
  en: {
    working: 'Working',
    writing: 'Writing the reply',
    tool: 'Running a tool: {tool}',
    waiting: 'Waiting for you to confirm in the popup',
    done: 'Finished',
    stopped: 'Stopped',
    error: 'Stopped by an error, see the chat',
  },
  ja: {
    working: '作業中',
    writing: '返信を作成中',
    tool: 'ツールを実行中: {tool}',
    waiting: 'ポップアップでの確認を待っています',
    done: '完了しました',
    stopped: '停止しました',
    error: 'エラーで停止しました。詳細はチャットをご覧ください',
  },
  ko: {
    working: '작업 중',
    writing: '답변을 쓰는 중',
    tool: '도구 실행 중: {tool}',
    waiting: '팝업에서 확인해 주시기를 기다리는 중',
    done: '끝났습니다',
    stopped: '멈췄습니다',
    error: '오류로 멈췄습니다. 대화를 확인하세요',
  },
  fr: {
    working: 'En cours',
    writing: 'Rédaction de la réponse',
    tool: 'Exécution d’un outil : {tool}',
    waiting: 'En attente de votre confirmation dans la fenêtre',
    done: 'Terminé',
    stopped: 'Arrêté',
    error: 'Arrêté à cause d’une erreur, voir la conversation',
  },
  de: {
    working: 'Arbeitet',
    writing: 'Schreibt die Antwort',
    tool: 'Führt ein Werkzeug aus: {tool}',
    waiting: 'Wartet auf Ihre Bestätigung im Popup',
    done: 'Fertig',
    stopped: 'Gestoppt',
    error: 'Wegen eines Fehlers gestoppt, siehe Chat',
  },
  es: {
    working: 'Trabajando',
    writing: 'Escribiendo la respuesta',
    tool: 'Ejecutando una herramienta: {tool}',
    waiting: 'Esperando su confirmación en la ventana emergente',
    done: 'Terminado',
    stopped: 'Detenido',
    error: 'Detenido por un error, vea el chat',
  },
  th: {
    working: 'กำลังทำงาน',
    writing: 'กำลังเขียนคำตอบ',
    tool: 'กำลังรันเครื่องมือ: {tool}',
    waiting: 'กำลังรอให้คุณยืนยันในหน้าต่างป๊อปอัป',
    done: 'เสร็จแล้ว',
    stopped: 'หยุดแล้ว',
    error: 'หยุดเพราะเกิดข้อผิดพลาด ดูรายละเอียดในแชต',
  },
  id: {
    working: 'Sedang bekerja',
    writing: 'Menulis balasan',
    tool: 'Menjalankan alat: {tool}',
    waiting: 'Menunggu Anda mengonfirmasi di jendela pop-up',
    done: 'Selesai',
    stopped: 'Dihentikan',
    error: 'Berhenti karena kesalahan, lihat obrolan',
  },
  ru: {
    working: 'Работает',
    writing: 'Пишет ответ',
    tool: 'Запуск инструмента: {tool}',
    waiting: 'Ожидает вашего подтверждения во всплывающем окне',
    done: 'Готово',
    stopped: 'Остановлено',
    error: 'Остановлено из-за ошибки, см. чат',
  },
  ar: {
    working: 'قيد العمل',
    writing: 'جارٍ كتابة الرد',
    tool: 'تشغيل أداة: {tool}',
    waiting: 'بانتظار تأكيدك في النافذة المنبثقة',
    done: 'اكتمل',
    stopped: 'تم الإيقاف',
    error: 'توقف بسبب خطأ، راجع المحادثة',
  },
  pt: {
    working: 'Trabalhando',
    writing: 'Escrevendo a resposta',
    tool: 'Executando uma ferramenta: {tool}',
    waiting: 'Aguardando sua confirmação na janela pop-up',
    done: 'Concluído',
    stopped: 'Interrompido',
    error: 'Interrompido por um erro, veja o chat',
  },
  it: {
    working: 'In corso',
    writing: 'Scrittura della risposta',
    tool: 'Esecuzione di uno strumento: {tool}',
    waiting: 'In attesa della tua conferma nella finestra popup',
    done: 'Completato',
    stopped: 'Interrotto',
    error: 'Interrotto da un errore, vedi la chat',
  },
  pl: {
    working: 'Pracuje',
    writing: 'Pisze odpowiedź',
    tool: 'Uruchamianie narzędzia: {tool}',
    waiting: 'Czeka na Twoje potwierdzenie w oknie podręcznym',
    done: 'Zakończono',
    stopped: 'Zatrzymano',
    error: 'Zatrzymano z powodu błędu, zobacz czat',
  },
  cs: {
    working: 'Pracuje',
    writing: 'Píše odpověď',
    tool: 'Spouštění nástroje: {tool}',
    waiting: 'Čeká na vaše potvrzení v místním okně',
    done: 'Hotovo',
    stopped: 'Zastaveno',
    error: 'Zastaveno kvůli chybě, viz chat',
  },
  nl: {
    working: 'Bezig',
    writing: 'Antwoord schrijven',
    tool: 'Een hulpmiddel uitvoeren: {tool}',
    waiting: 'Wacht op uw bevestiging in het pop-upvenster',
    done: 'Klaar',
    stopped: 'Gestopt',
    error: 'Gestopt door een fout, zie de chat',
  },
  ms: {
    working: 'Sedang berfungsi',
    writing: 'Menulis balasan',
    tool: 'Menjalankan alat: {tool}',
    waiting: 'Menunggu pengesahan anda dalam tetingkap timbul',
    done: 'Selesai',
    stopped: 'Dihentikan',
    error: 'Dihentikan oleh ralat, lihat sembang',
  },
  he: {
    working: 'עובד',
    writing: 'כותב את התשובה',
    tool: 'מפעיל כלי: {tool}',
    waiting: 'ממתין לאישור שלך בחלון הקופץ',
    done: 'הסתיים',
    stopped: 'נעצר',
    error: 'נעצר עקב שגיאה, ראו את השיחה',
  },
  hi: {
    working: 'काम चल रहा है',
    writing: 'उत्तर लिखा जा रहा है',
    tool: 'टूल चल रहा है: {tool}',
    waiting: 'पॉप-अप में आपकी पुष्टि का इंतज़ार है',
    done: 'पूरा हुआ',
    stopped: 'रुक गया',
    error: 'त्रुटि के कारण रुक गया, चैट देखें',
  },
  'zh-TW': {
    working: '處理中',
    writing: '正在撰寫回覆',
    tool: '正在執行工具：{tool}',
    waiting: '等待您在彈出視窗中確認',
    done: '已完成',
    stopped: '已停止',
    error: '因錯誤而停止，詳情見對話',
  },
  vi: {
    working: 'Đang làm việc',
    writing: 'Đang viết phản hồi',
    tool: 'Đang chạy công cụ: {tool}',
    waiting: 'Đang chờ bạn xác nhận trong cửa sổ bật lên',
    done: 'Đã xong',
    stopped: 'Đã dừng',
    error: 'Đã dừng do lỗi, xem cuộc trò chuyện',
  },
}
