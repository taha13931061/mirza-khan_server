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
