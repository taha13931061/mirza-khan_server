// Riddle pool for the "lucky puzzle" mode that appears once two players are matched
// in online battle. Organized by difficulty level (green/yellow/red).
//
// This is a small STARTER set so the feature is real and testable today.
// To load your real set of 180 riddles: send them to me as
// "سوال | جواب" one per line (or a spreadsheet), grouped by level, and I'll
// replace this file with the full set — the server code doesn't need to change,
// only this list.

const RIDDLES = {
  green: [
    { id: 'g1', question: 'چه چیزی هر چه از آن بردارید، بزرگ‌تر می‌شود؟', answer: 'چاله' },
    { id: 'g2', question: 'چیست آن که دندان دارد ولی نمی‌جود؟', answer: 'شانه' },
    { id: 'g3', question: 'چه چیزی همیشه می‌آید ولی هیچ‌وقت نمی‌رسد؟', answer: 'فردا' },
    { id: 'g4', question: 'چیست آن که پا دارد ولی راه نمی‌رود؟', answer: 'میز' },
    { id: 'g5', question: 'چه چیزی وقتی می‌شکند، بهتر کار می‌کند؟', answer: 'تخم مرغ' },
    { id: 'g6', question: 'چیست آن که چشم دارد ولی نمی‌بیند؟', answer: 'سوزن' },
    { id: 'g7', question: 'چه چیزی گرد است ولی توپ نیست، خوردنی است؟', answer: 'نان' },
  ],
  yellow: [
    { id: 'y1', question: 'چیست آن که در روز پنهان و در شب آشکار است؟', answer: 'ستاره' },
    { id: 'y2', question: 'چه چیزی هرچه پرترش کنی، سبک‌تر می‌شود؟', answer: 'کیسه سوراخ' },
    { id: 'y3', question: 'کدام کلمه هر بار که آن را بگویی، خودش را می‌شکند؟', answer: 'سکوت' },
    { id: 'y4', question: 'چیست آن که مادرش سنگ است و خودش شیشه؟', answer: 'شن' },
    { id: 'y5', question: 'چه چیزی بدون پا می‌دود و بدون دهان فریاد می‌زند؟', answer: 'رودخانه' },
    { id: 'y6', question: 'کدام درخت هیچ‌وقت برگ ندارد؟', answer: 'نخل خشک' },
  ],
  red: [
    { id: 'r1', question: 'دو برادرند که هیچ‌وقت همدیگر را نمی‌بینند، کیستند؟', answer: 'شب و روز' },
    { id: 'r2', question: 'چیزی که هر چه به آن بدهی، هرگز پر نمی‌شود؟', answer: 'دریا' },
    { id: 'r3', question: 'کدام عدد را اگر از خودش کم کنی، باز هم خودش می‌ماند؟', answer: 'صفر' },
    { id: 'r4', question: 'چه چیزی را نمی‌توان لمس کرد ولی می‌توان شکست؟', answer: 'قول' },
    { id: 'r5', question: 'چیست آن که هرچه بیشتر از آن برداری، بزرگ‌تر می‌شود، ولی هرچه کمتر بگذاری، آرام‌تر می‌شود؟', answer: 'راز' },
  ],
};

const REWARDS = {
  green:  { coins: 10, gems: 0 },
  yellow: { coins: 20, gems: 2 },
  red:    { coins: 40, gems: 5 },
};

function pickFive(level) {
  const pool = RIDDLES[level] || RIDDLES.green;
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(5, shuffled.length));
}

module.exports = { RIDDLES, REWARDS, pickFive };
