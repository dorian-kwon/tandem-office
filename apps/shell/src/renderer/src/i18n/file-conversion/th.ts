import type { zh } from './zh'

export const th = {
  title: 'แปลงไฟล์',
  chooseFiles: 'เลือกไฟล์',
  outputFormat: 'รูปแบบไฟล์ปลายทาง',
  convert: 'แปลง',
  converting: 'กำลังแปลง…',
  destinationHint:
    'ไฟล์ที่แปลงแล้วจะบันทึกไว้ในโฟลเดอร์เดียวกับไฟล์ต้นฉบับแต่ละไฟล์ หากชื่อซ้ำ จะเติมตัวเลขในชื่อไฟล์ใหม่',
  noCommonFormat:
    'ไฟล์ที่เลือกไม่มีรูปแบบปลายทางที่ใช้ร่วมกันได้ โปรดนำบางไฟล์ออกจากรายการหรือเลือกไฟล์อื่น',
  chooseFailed: 'เปิดหน้าต่างเลือกไฟล์ไม่ได้',
  convertFailed: 'แปลงไฟล์ไม่สำเร็จ',
  saved: 'บันทึกแล้ว',
  failed: 'แปลงไม่สำเร็จ',
  removeFile: 'นำ {name} ออกจากรายการ',
} satisfies Record<keyof typeof zh, string>
