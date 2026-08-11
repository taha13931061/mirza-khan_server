// Server-side copy of stage data. The client sends which words it thinks
// it found; the server checks that against THIS list before paying out any
// coins or XP — the client is never trusted for rewards.

const STAGES = [
  { id: 1, words: ['سر', 'ابر', 'بار'], name: 'مرحله ۱ — واحه' },
  { id: 2, words: ['دیر', 'یار', 'دریا'], name: 'مرحله ۲ — کرانه' },
  { id: 3, words: ['مات', 'تیم', 'هما', 'ماهی'], name: 'مرحله ۳ — دریاچه' },
  { id: 4, words: ['باک', 'تاک', 'کتاب'], name: 'مرحله ۴ — کتابخانه' },
  { id: 5, words: ['پند', 'نرد', 'پدر', 'پرنده'], name: 'مرحله ۵ — باغ' },
  { id: 6, words: ['باغ', 'گلاب', 'بال'], name: 'مرحله ۶ — گلستان' },
  { id: 7, words: ['کوه', 'سنگ', 'ستون', 'کوهستان'], name: 'مرحله ۷ — قله' },
  { id: 8, words: ['باز', 'راز', 'بازار'], name: 'مرحله ۸ — بازار' },
  { id: 9, words: ['سر', 'راه', 'ستاره'], name: 'مرحله ۹ — کویر' },
  { id: 10, words: ['میز', 'خانه', 'میرزا', 'میرزاخان'], name: 'مرحله ۱۰ — دیوان‌خانه' },
];

function rewardFor(stage) {
  return {
    coins: 20 + stage.words.length * 5,
    xp: 30 + stage.words.length * 8,
  };
}

module.exports = { STAGES, rewardFor };
