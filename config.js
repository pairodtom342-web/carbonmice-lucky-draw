/* carbonMICE Lucky Draw v2 — config กลาง (admin.html + index.html ใช้ร่วมกัน)
 * ─────────────────────────────────────────────────────────────
 * API_URL   = /exec ของ Apps Script Web App (backend Lucky Draw — คนละตัวกับเกมบูท)
 * ADMIN_PIN = รหัสเข้าหน้า admin (client-side gate)
 * ADMIN_KEY = ต้องตรงกับ ADMIN_KEY ใน backend/Code.gs (ใช้ยืนยันทุก action ฝั่ง admin)
 *             ⚠️ อยู่ในหน้า admin เท่านั้น — หน้าบ้านลูกค้า (index.html) ไม่ใช้/ไม่โหลดค่านี้ไปแตะ
 */
window.CMLD_CONFIG = {
  API_URL:   "https://script.google.com/macros/s/AKfycbz54CzK1BkEZ7RG9R7rDicBo36hivkF4JO2O1CMxzc6aDon91NndxVf-KJKZcIvrjSuWw/exec",
  ADMIN_PIN: "2468",
  ADMIN_KEY: "cmLD-pea-2026-k7x9q3"
};
