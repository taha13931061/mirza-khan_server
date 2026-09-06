# بک‌اند بازی میرزاخان

این پوشه شامل کد کامل و واقعی سرور بازیه: حساب کاربری، سکه/XP امن روی سرور،
مراحل، پنل مدیریت، چت زنده، و مبارزه‌ی آنلاین ساده.

## چی داخلشه
- `server.js` — کل منطق سرور (API + چت + مبارزه)
- `stages.js` — لیست کلمات هر مرحله (برای اعتبارسنجی سمت سرور)
- `db.js` — پایگاه‌داده‌ی ساده (یک فایل JSON — نیازی به نصب دیتابیس جدا نیست)
- `public/admin/index.html` — پنل مدیریت وب (با ورود جدا از بازیکن‌ها)
- `.env.example` — نمونه‌ی تنظیمات امن (رمزها را اینجا ننویس، در `.env` واقعی بنویس)

## 🔐 امنیت — یه کار دستی مهم روی Render
تو Render → Environment، یه متغیر به اسم `JWT_SECRET` بساز و یه رشته‌ی طولانی و رندوم بذار
(مثلاً ۴۰-۶۴ کاراکتر تصادفی). بدون این کار، سرور خودش موقع روشن شدن یه رمز رندوم می‌سازه —
امن هست ولی هر بار که سرور ری‌استارت بشه، همه از حساب‌شون خارج می‌شن. با یه JWT_SECRET
ثابت، این اتفاق نمی‌افته.

## ⚠️ یه کار دستی لازم (فقط یک بار) — اضافه کردن ستون جم
این نسخه واحد پول «جم» و «کوله‌پشتی آیتم‌ها» رو اضافه کرده. چون حساب‌ها روی Supabase
ذخیره می‌شن، باید یه بار این دستور رو تو **Supabase → SQL Editor** اجرا کنی:

```sql
alter table users add column if not exists gems integer default 0;
alter table users add column if not exists inventory jsonb default '{}'::jsonb;
alter table users add column if not exists ban_until timestamptz;
alter table users add column if not exists custom_id text unique;
create table if not exists app_settings (
  id integer primary key,
  maintenance_enabled boolean default false,
  maintenance_reason text default '',
  maintenance_ends_at timestamptz
);
create table if not exists chat_messages (
  id bigserial primary key,
  room text not null,
  sender_id integer not null,
  sender_username text not null,
  text text not null,
  created_at timestamptz default now()
);
create index if not exists chat_messages_room_idx on chat_messages(room, created_at);
create table if not exists chat_groups (
  id bigserial primary key,
  name text not null,
  creator_id integer not null,
  created_at timestamptz default now()
);
create table if not exists chat_group_members (
  group_id bigint references chat_groups(id) on delete cascade,
  user_id integer not null,
  primary key (group_id, user_id)
);
create table if not exists chat_reports (
  id bigserial primary key,
  reporter_id integer not null,
  reporter_username text,
  reported_username text,
  message_id bigint,
  reason text,
  status text default 'open',
  created_at timestamptz default now()
);
alter table chat_reports add column if not exists reporter_username text;
alter table chat_reports add column if not exists reported_username text;

create table if not exists game_events (
  id bigserial primary key,
  title text not null,
  description text,
  type text not null,
  target integer not null default 1,
  reward_coins integer default 0,
  reward_gems integer default 0,
  active boolean default true,
  created_at timestamptz default now()
);
create table if not exists daily_missions (
  id bigserial primary key,
  title text not null,
  description text,
  type text not null,
  target integer not null default 1,
  reward_coins integer default 0,
  reward_gems integer default 0,
  active boolean default true
);
create table if not exists progress_log (
  user_id integer not null,
  item_type text not null,
  item_id bigint not null,
  day date not null,
  progress integer default 0,
  claimed boolean default false,
  primary key (user_id, item_type, item_id, day)
);
create table if not exists daily_rewards (
  user_id integer primary key,
  streak integer default 0,
  last_claim date
);

create table if not exists custom_stages (
  id integer primary key,
  letters jsonb not null,
  words jsonb not null,
  name text not null,
  char jsonb not null
);

create table if not exists friendships (
  user_a integer not null,
  user_b integer not null,
  status text not null default 'pending', -- 'pending' | 'accepted'
  requested_by integer not null,
  created_at timestamptz default now(),
  primary key (user_a, user_b)
);
```

این جدول آخر (`friendships`) لازمه تا بخش «دوستان» واقعاً کار کنه — قبلاً فقط تو حافظه‌ی
مرورگر خود گوشی ذخیره می‌شد (نه رو سرور)، برای همین هیچ‌وقت واقعاً به طرف مقابل درخواست
دوستی نمی‌رسید. بدون این جدول، دکمه‌های دوستان خطای «جدول friendships رو تو Supabase
ساختی؟» می‌دن.

```sql
create table if not exists battle_history (
  id bigserial primary key,
  battle_id text not null,
  level text not null,
  player_id integer not null,
  opponent_id integer,
  opponent_username text,
  result text not null, -- 'win' | 'loss' | 'draw'
  score integer not null default 0,
  opponent_score integer not null default 0,
  created_at timestamptz default now()
);
create index if not exists battle_history_player_idx on battle_history(player_id, created_at desc);
```

این جدول تاریخچه‌ی مبارزات آنلاین رو نگه می‌داره — هم برای «مبارزات اخیر من» تو پروفایل،
هم برای جدول امتیازات بر اساس تعداد برد. بدون این جدول، هر دو خطای «جدول battle_history
رو تو Supabase ساختی؟» می‌دن (ولی خود مبارزه‌ها و جایزه‌شون عادی کار می‌کنن — فقط ثبت
تاریخچه انجام نمی‌شه).

```sql
alter table app_settings add column if not exists min_version text;
alter table app_settings add column if not exists update_url text;
alter table app_settings add column if not exists update_message text;
alter table app_settings add column if not exists broadcast_text text;
alter table app_settings add column if not exists broadcast_at timestamptz;
```

این ستون‌ها به همون جدول `app_settings` (که برای حالت خاموشی/تعمیرات استفاده می‌شد) اضافه
می‌شن. سه‌تای اول پایه‌ی سیستم «بروزرسانی اجباری» هستن، دوتای آخر برای «پیام همگانی» —
از پنل مدیریت، بخش‌های «🔄 نسخه اپ» و «📢 پیام همگانی» ازشون استفاده می‌کنن.

```sql
create table if not exists purchases (
  id bigserial primary key,
  user_id integer not null,
  package_id text not null,
  amount_toman integer not null,
  reward_type text not null, -- 'coins' | 'gems'
  reward_amount integer not null,
  status text not null default 'pending', -- pending | paid | failed
  gateway_transid text,
  created_at timestamptz default now(),
  paid_at timestamptz
);
create index if not exists purchases_transid_idx on purchases(gateway_transid);
create index if not exists purchases_user_idx on purchases(user_id);
```

## فروشگاه واقعی (خرید سکه/جم با پول واقعی)

این جدول (`purchases`) پایه‌ی «فروشگاه رسمی بازی» هست — همون جایی که کاربر با کارت بانکی
واقعاً سکه/جم می‌خره، از داخل بازی (دکمه‌ی «🛒 ورود به فروشگاه» تو تب «خرید جم» فروشگاه).

**تنظیم درگاه:** یه متغیر محیطی رو Render اضافه کن:
- `AQAYEPARDAKHT_PIN` → پین درگاه آقای پرداخت. تا وقتی پین واقعی نگرفتی، این رو خالی
  بذار یا مقدار `sandbox` بهش بده — همون endpoint های واقعی رو صدا می‌زنه ولی بدون پول
  واقعی، دقیقاً برای همین مرحله‌ی تایید سایت که آقای پرداخت ازت خواسته ساخته شده.

**آدرس فروشگاه:** همین که این آپدیت رو دیپلوی کنی، فروشگاه خودکار در دسترس می‌شه، بدون
هیچ تنظیم اضافه‌ای:
`https://<آدرس-سرور-تو-Render>/shop/`

اگه دامنه‌ی جدیدت (همونی که رو آروان‌کلود داری) رو هم بخوای همینو نشون بده، کافیه تو
پنل Render، تو تنظیمات همین سرویس، بخش **Custom Domains** رو باز کنی، دامنه‌ت رو اضافه
کنی، و رکورد DNS ای (معمولاً یه CNAME) که Render نشونت می‌ده رو تو پنل DNS آروان‌کلود
اضافه کنی. بعد از چند دقیقه (تا انتشار DNS)، همون فروشگاه رو دامنه‌ی خودت هم بالا میاد —
بدون اینکه کد عوض بشه.

**بسته‌های فروش:** قیمت‌ها و مقدار سکه/جم هر بسته تو فایل `store.js`، آبجکت `PACKAGES`
تعریف شده — همون‌جا (اسم، قیمت به تومان، مقدار سکه/جم) رو ویرایش کن، بدون نیاز به تغییر
جای دیگه‌ی کد.

**مهم برای وقتی پین واقعی گرفتی:** فقط مقدار `AQAYEPARDAKHT_PIN` رو رو Render عوض کن
به پین واقعی — هیچ کد دیگه‌ای نیاز به تغییر نداره.

## نسخه‌ی استار

```sql
alter table users add column if not exists is_star boolean not null default false;
```

این یه ستون سادست رو جدول `users` — از پنل مدیریت، کنار هر بازیکن دکمه‌ی «⭐ استار کن»
هست که این فلگ رو روشن/خاموش می‌کنه. حساب‌های استار: راهنما براشون رایگانه، به همه‌ی
مراحل بدون ترتیب دسترسی دارن، و تو کل اپ (منو، پروفایل، لیدربورد، پنل مدیریت) یه ⭐ کنار
اسمشون و تم طلایی می‌بینن. تشخیص «استار بودن» کاملاً سمت سرور و بر اساس **حساب**
هست — نه بر اساس اینکه از کدوم نسخه‌ی APK (عادی یا استار) وصل شدی. یعنی همین یک فایل
`index.html` برای هر دو نسخه کافیه؛ اسم/آیکون دو تا APK از هم فرق می‌کنه، ولی کدشون یکیه.

**نکته‌ی صادقانه:** یکی از خواسته‌های اولیه «جان نامحدود» بود — ولی الان تو کل بازی
هیچ مکانیزم واقعی‌ای برای کم شدن جان با جواب غلط وجود نداره (جان فقط تزئینیه و از
فروشگاه خریداری می‌شه)، پس این مورد رو پیاده نکردم چون چیزی برای «نامحدود کردنش» نبود.
اگه بخوای، اول باید یه سیستم واقعی جان اضافه کنیم، بعد استارها ازش معاف بشن.

## مدیریت فروشگاه از پنل (بسته‌ها + سفارش‌ها)

```sql
create table if not exists store_packages (
  id text primary key,
  label text not null,
  price_toman integer not null,
  reward_type text not null, -- 'coins' | 'gems'
  reward_amount integer not null,
  active boolean not null default true,
  created_at timestamptz default now()
);

-- بسته‌های اولیه (همونایی که قبلاً تو کد بودن) — می‌تونی بعداً از پنل مدیریت
-- ویرایش/حذفشون کنی یا بسته‌ی جدید اضافه کنی، بدون نیاز به SQL دوباره.
insert into store_packages (id, label, price_toman, reward_type, reward_amount) values
  ('coins_100', '۱۰۰ سکه', 15000, 'coins', 100),
  ('coins_550', '۵۵۰ سکه (۵۰۰ + ۵۰ هدیه)', 65000, 'coins', 550),
  ('gems_20', '۲۰ جم', 25000, 'gems', 20),
  ('gems_110', '۱۱۰ جم (۱۰۰ + ۱۰ هدیه)', 110000, 'gems', 110)
on conflict (id) do nothing;
```

این جدول جایگزین لیست ثابتی شد که قبلاً تو `store.js` نوشته شده بود — از پنل مدیریت،
بخش «🛒 مدیریت فروشگاه» (فقط برای owner/creator، چون داده‌ی مالیه)، دو تا تب داره:
- **سفارش‌ها:** همه‌ی خریدها (در انتظار/انجام‌شده/ناموفق) با اسم خریدار و مبلغ
- **بسته‌ها:** لیست بسته‌های فعلی + فرم اضافه کردن بسته‌ی جدید + دکمه‌ی غیرفعال/حذف کردن

بدون این جدول، فروشگاه (هم `/shop/` هم بخش مدیریتش) خطای «جدول store_packages رو تو
Supabase ساختی؟» می‌ده.

این جدول‌های جدید باعث می‌شن چت (همگانی، گروهی، خصوصی) و گزارش‌ها واقعاً رو سرور ذخیره بشن —
قبلاً رو یه فایل محلی بودن که هر بار سرور ری‌استارت/آپدیت می‌شد، پاک می‌شدن.

بدون این کار، سرور موقع ذخیره‌ی جم یا آیتم‌های خریداری‌شده خطا می‌ده.

## جلوگیری از خواب رفتن سرور (رایگان)
پلن رایگان Render بعد از ~۱۵ دقیقه بدون درخواست ورودی می‌خوابه و بیدار شدنش ۲۰-۵۰+ ثانیه طول می‌کشه.
خود بازی هر ۵ دقیقه یه پینگ می‌فرسته، ولی این فقط وقتی کار می‌کنه که حداقل یه نفر بازی رو باز داشته باشه.
برای این‌که سرور **همیشه** بیدار بمونه (حتی وقتی هیچ‌کس بازی رو باز نکرده)، یکی از این سرویس‌های رایگان رو تنظیم کن:

1. برو **uptimerobot.com** یا **cron-job.org** و ثبت‌نام کن (رایگان، نیاز به کارت بانکی نداره)
2. یه Monitor/Job جدید بساز
3. آدرس رو بذار: `https://api.mirzakhan.ir/api/health`
4. فاصله‌ی زمانی رو بذار روی **هر ۵ یا ۱۰ دقیقه**
5. ذخیره کن

از این به بعد، این سرویس هر چند دقیقه یه‌بار به سرور سر می‌زنه و اجازه نمی‌ده کامل بخوابه.

## برای این‌که یه حساب، مدیر اصلی (owner) بشه — یه بار دستی
```sql
update users set role = 'owner' where username = 'یوزرنیم_خودت';
```
این کار رو هم تو همون SQL Editor بزن. بعدش با همون حساب وارد بازی شو تا پنل مدیریت واقعاً کار کنه.

## قدم‌به‌قدم گذاشتنش روی اینترنت (Render.com — رایگان)

۱. برو به **github.com** و یه Repository جدید بساز (خالی)
   - اسمش رو بذار مثلاً `mirza-khan-server`
   - همه‌ی فایل‌های این پوشه رو (به‌جز چیزهایی که در `.gitignore` هست) توش آپلود کن
   - از دکمه‌ی "Add file → Upload files" توی خود سایت گیت‌هاب استفاده کن (نیازی به نصب چیزی نیست)

۲. برو به **render.com** و ثبت‌نام کن (می‌تونی مستقیم با حساب گیت‌هابت وارد شی)

۳. توی داشبورد Render:
   - "New +" → "Web Service"
   - همون Repository که ساختی رو انتخاب کن
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - پایین صفحه بخش **Environment Variables** رو باز کن و این‌ها رو اضافه کن:
     - `JWT_SECRET` → یه رشته‌ی طولانی و تصادفی
     - `ADMIN_USERNAME` → نام کاربری دلخواه برای ورود به پنل مدیریت
     - `ADMIN_PASSWORD` → یه رمز قوی
   - دکمه‌ی "Create Web Service" رو بزن

۴. بعد از چند دقیقه، Render یه آدرس بهت میده مثل:
   `https://mirza-khan-server.onrender.com`

۵. پنل مدیریت اینجاست: `https://mirza-khan-server.onrender.com/admin`
   (با همون ADMIN_USERNAME و ADMIN_PASSWORD که خودت تعیین کردی وارد شو)

## نکته‌ی مهم درباره‌ی ذخیره‌سازی
پایگاه‌داده‌ی این نسخه یه فایل ساده است (`data/db.json`) — برای شروع و تست کاملاً کافیه.
اما روی هاست رایگان Render، اگه سرور دوباره ساخته بشه (redeploy)، ممکنه این فایل
از اول خالی بشه. وقتی بازی واقعی شد و بازیکن جدی پیدا کرد، باید این بخش رو با
یه دیتابیس واقعی (مثلاً Supabase — که رایگان هم هست) عوض کنیم. ساختار کد طوری
نوشته شده که این تعویض بعداً راحت باشه.

## قدم بعدی
کلاینت بازی (همون فایل html که قبلاً داری) هنوز به این سرور وصل نیست —
هنوز سکه‌ها و پیشرفت رو محلی روی خود گوشی نگه می‌داره. قدم بعدی وصل کردن
کلاینت به همین سرور هست (تا واقعاً حساب کاربری و سکه‌ی امن داشته باشی).
