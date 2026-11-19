import type { Lang } from '@genoffice/i18n'
import type { UpdateVersionStrings } from '../shared/update-api'

const text: Record<Lang, [string, string, string, string, string]> = {
  en: [
    'Other versions',
    'Loading versions…',
    'No other versions for this platform.',
    'Could not load or select a version. Try again.',
    'Install selected version',
  ],
  ko: [
    '다른 버전',
    '버전을 불러오는 중…',
    '이 환경에 설치할 다른 버전이 없습니다.',
    '버전을 불러오거나 선택할 수 없습니다. 다시 시도하세요.',
    '선택한 버전 설치',
  ],
  zh: [
    '其他版本',
    '正在载入版本…',
    '此平台没有其他可安装版本。',
    '无法载入或选择版本，请重试。',
    '安装所选版本',
  ],
  'zh-TW': [
    '其他版本',
    '正在載入版本…',
    '此平台沒有其他可安裝版本。',
    '無法載入或選擇版本，請重試。',
    '安裝所選版本',
  ],
  ja: [
    '他のバージョン',
    'バージョンを読み込み中…',
    'この環境にインストールできる他のバージョンはありません。',
    'バージョンを読み込めないか選択できません。再試行してください。',
    '選択したバージョンをインストール',
  ],
  vi: [
    'Phiên bản khác',
    'Đang tải phiên bản…',
    'Không có phiên bản khác cho nền tảng này.',
    'Không thể tải hoặc chọn phiên bản. Hãy thử lại.',
    'Cài đặt phiên bản đã chọn',
  ],
  fr: [
    'Autres versions',
    'Chargement des versions…',
    'Aucune autre version pour cette plateforme.',
    'Impossible de charger ou de sélectionner une version. Réessayez.',
    'Installer la version sélectionnée',
  ],
  de: [
    'Andere Versionen',
    'Versionen werden geladen…',
    'Keine weiteren Versionen für diese Plattform.',
    'Version konnte nicht geladen oder ausgewählt werden. Erneut versuchen.',
    'Ausgewählte Version installieren',
  ],
  es: [
    'Otras versiones',
    'Cargando versiones…',
    'No hay otras versiones para esta plataforma.',
    'No se pudo cargar o seleccionar una versión. Inténtalo de nuevo.',
    'Instalar la versión seleccionada',
  ],
  th: [
    'เวอร์ชันอื่น',
    'กำลังโหลดเวอร์ชัน…',
    'ไม่มีเวอร์ชันอื่นสำหรับแพลตฟอร์มนี้',
    'โหลดหรือเลือกเวอร์ชันไม่ได้ โปรดลองอีกครั้ง',
    'ติดตั้งเวอร์ชันที่เลือก',
  ],
  id: [
    'Versi lain',
    'Memuat versi…',
    'Tidak ada versi lain untuk platform ini.',
    'Versi tidak dapat dimuat atau dipilih. Coba lagi.',
    'Instal versi yang dipilih',
  ],
  ru: [
    'Другие версии',
    'Загрузка версий…',
    'Для этой платформы нет других версий.',
    'Не удалось загрузить или выбрать версию. Попробуйте ещё раз.',
    'Установить выбранную версию',
  ],
  ar: [
    'إصدارات أخرى',
    'جارٍ تحميل الإصدارات…',
    'لا توجد إصدارات أخرى لهذه المنصة.',
    'تعذّر تحميل إصدار أو اختياره. حاول مجددًا.',
    'تثبيت الإصدار المحدد',
  ],
  pt: [
    'Outras versões',
    'Carregando versões…',
    'Não há outras versões para esta plataforma.',
    'Não foi possível carregar ou selecionar a versão. Tente de novo.',
    'Instalar a versão selecionada',
  ],
  it: [
    'Altre versioni',
    'Caricamento delle versioni…',
    'Non ci sono altre versioni per questa piattaforma.',
    'Impossibile caricare o selezionare la versione. Riprova.',
    'Installa la versione selezionata',
  ],
  pl: [
    'Inne wersje',
    'Wczytywanie wersji…',
    'Brak innych wersji dla tej platformy.',
    'Nie można wczytać lub wybrać wersji. Spróbuj ponownie.',
    'Zainstaluj wybraną wersję',
  ],
  cs: [
    'Jiné verze',
    'Načítání verzí…',
    'Pro tuto platformu nejsou k dispozici jiné verze.',
    'Verzi se nepodařilo načíst nebo vybrat. Zkuste to znovu.',
    'Nainstalovat vybranou verzi',
  ],
  nl: [
    'Andere versies',
    'Versies laden…',
    'Geen andere versies voor dit platform.',
    'Versie kon niet worden geladen of geselecteerd. Probeer opnieuw.',
    'Geselecteerde versie installeren',
  ],
  ms: [
    'Versi lain',
    'Memuatkan versi…',
    'Tiada versi lain untuk platform ini.',
    'Versi tidak dapat dimuatkan atau dipilih. Cuba lagi.',
    'Pasang versi yang dipilih',
  ],
  he: [
    'גרסאות אחרות',
    'טוען גרסאות…',
    'אין גרסאות אחרות לפלטפורמה זו.',
    'לא ניתן לטעון או לבחור גרסה. נסו שוב.',
    'התקנת הגרסה שנבחרה',
  ],
  hi: [
    'अन्य संस्करण',
    'संस्करण लोड हो रहे हैं…',
    'इस प्लेटफ़ॉर्म के लिए कोई अन्य संस्करण नहीं है।',
    'संस्करण लोड या चुना नहीं जा सका। फिर कोशिश करें।',
    'चुना गया संस्करण इंस्टॉल करें',
  ],
}

export function updateVersionStrings(lang: Lang): UpdateVersionStrings {
  const [label, loading, empty, failed, install] = text[lang]
  return { label, loading, empty, failed, install }
}
