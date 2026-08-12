// Single source of truth for stage data — letters, words (answers), and characters.
// The client NEVER receives the `words` array directly; only /api/stage/:id/play
// (letters + word lengths) and /api/stage/:id/check (pass/fail per guess).

const STAGES = [
  { id:1, letters:['ا','ب','ر','س'], words:['سر','ابر','بار'], name:'مرحله ۱ — واحه', char:{ emoji:'🧕', name:'بی‌بی‌گل' } },
  { id:2, letters:['د','ر','ی','ا'], words:['دیر','یار','دریا'], name:'مرحله ۲ — کرانه', char:{ emoji:'⚓', name:'ناخدا رستم' } },
  { id:3, letters:['م','ا','ه','ی','ت'], words:['مات','تیم','هما','ماهی'], name:'مرحله ۳ — دریاچه', char:{ emoji:'🎣', name:'ماهیگیر یوسف' } },
  { id:4, letters:['ک','ت','ا','ب'], words:['باک','تاک','کتاب'], name:'مرحله ۴ — کتابخانه', char:{ emoji:'📚', name:'استاد فرهاد' } },
  { id:5, letters:['پ','ر','ن','د','ه'], words:['پند','نرد','پدر','پرنده'], name:'مرحله ۵ — باغ', char:{ emoji:'🌳', name:'باغبان آرش' } },
  { id:6, letters:['گ','ل','ب','ا','غ'], words:['باغ','گلاب','بال'], name:'مرحله ۶ — گلستان', char:{ emoji:'🌷', name:'گلاب‌بانو' } },
  { id:7, letters:['ک','و','ه','س','ت','ا','ن'], words:['کوه','سنگ','ستون','کوهستان'], name:'مرحله ۷ — قله', char:{ emoji:'🏔️', name:'دده کوهیار' } },
  { id:8, letters:['ب','ا','ز','ا','ر'], words:['باز','راز','بازار'], name:'مرحله ۸ — بازار', char:{ emoji:'🏺', name:'حاج‌آقا کریم' } },
  { id:9, letters:['س','ت','ا','ر','ه'], words:['سر','راه','ستاره'], name:'مرحله ۹ — کویر', char:{ emoji:'🐫', name:'کاروان‌سالار نادر' } },
  { id:10, letters:['م','ی','ر','ز','ا','خ','ا','ن'], words:['میز','خانه','میرزا','میرزاخان'], name:'مرحله ۱۰ — دیوان‌خانه', char:{ emoji:'🖋️', name:'استاد میرزاخان' } },
  { id:11, letters:['ک','ا','ر','د'], words:['کار','دار','کارد'], name:'مرحله ۱۱ — کارگاه', char:{ emoji:'🔨', name:'استاد رضا' } },
  { id:12, letters:['خ','ا','ن','ه','م'], words:['خانم','خانه','نه'], name:'مرحله ۱۲ — اتاق‌نشیمن', char:{ emoji:'👵', name:'خانم‌جان' } },
  { id:13, letters:['ب','ا','د','ه'], words:['باد','باده','ده'], name:'مرحله ۱۳ — میخانه', char:{ emoji:'🍇', name:'اسفندیار' } },
  { id:14, letters:['س','ب','ز','ه'], words:['سبز','سبزه','به'], name:'مرحله ۱۴ — چمنزار', char:{ emoji:'🌱', name:'باغبان سبزینه' } },
  { id:15, letters:['ش','ه','ر','ی'], words:['شهر','شهری','ری'], name:'مرحله ۱۵ — شهر', char:{ emoji:'🏙️', name:'شهردار آبان' } },
  { id:16, letters:['ر','و','س','ت','ا'], words:['راست','سوار','روستا'], name:'مرحله ۱۶ — روستا', char:{ emoji:'🐐', name:'کدخدای ده' } },
  { id:17, letters:['د','ا','ن','ش','گ','ا','ه'], words:['دانش','گاه','دانشگاه'], name:'مرحله ۱۷ — دانشگاه', char:{ emoji:'🎓', name:'دکتر دانش' } },
  { id:18, letters:['ک','ت','ا','ب','خ','ا','ن','ه'], words:['کتاب','خانه','کتابخانه'], name:'مرحله ۱۸ — کتابخانه‌ی بزرگ', char:{ emoji:'📖', name:'کتابدار مهتاب' } },
  { id:19, letters:['ف','ر','ه','ن','گ'], words:['فرهنگ','رنگ','فن'], name:'مرحله ۱۹ — کارگاه هنر', char:{ emoji:'🎨', name:'نگارگر فرهاد' } },
  { id:20, letters:['م','ی','ر','ز','ا','خ','ا','ن','ب','گ'], words:['میرزا','خان','بزرگ','میرزاخان'], name:'مرحله ۲۰ — تخت میرزاخان', char:{ emoji:'👑', name:'پادشاه میرزا' } },
];

function rewardFor(stage) {
  return {
    coins: 20 + stage.words.length * 5,
    xp: 30 + stage.words.length * 8,
  };
}

module.exports = { STAGES, rewardFor };
