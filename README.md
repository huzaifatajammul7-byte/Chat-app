# WhatsApp-style Chat (Railway par aik hi service: website + backend)

- **Frontend:** Vite (3 pages: login, chat, admin). `npm run build` isse `dist/` folder me bana deta hai.
- **Backend:** Express + MongoDB. Ye khud `dist/` ki files static hosting ki tarah dikhata hai, to alag Netlify/Vercel ki zaroorat nahi.
- **Realtime:** asli **Socket.io** (messages, ticks, typing, online status aur calls ka signalling foran). Wohi server, wohi port, alag service ya key nahi chahiye.
- Aik hi Railway service = aik hi link = website bhi, API bhi.

## 1. MongoDB Atlas (database)
1. Atlas me **Network Access** -> **Add IP Address** -> `0.0.0.0/0` likho -> **Confirm** (Active hone tak 1-2 minute ruko).
2. **Database Access** me user banao (password sirf letters aur numbers).
3. **Database** -> **Connect** -> **Drivers** se string lo aur `<db_password>` ki jagah password, aur `.net/?` ko `.net/chatapp?` karo:
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/chatapp?retryWrites=true&w=majority`

## 2. GitHub par daalo
Is folder ke **andar ki cheezein** (jahan `package.json` hai) repo ke upar (root) me honi chahiye. `.env` aur `node_modules` push nahi hote (`.gitignore` roakti hai).
```
git init
git add .
git commit -m "chat app"
git branch -M main
git remote add origin https://github.com/APNA-USERNAME/REPO-NAME.git
git push -u origin main
```

## 3. Railway par deploy
1. railway.com -> **New Project** -> **Deploy from GitHub repo** -> apna repo chuno. **Root Directory khali rakho.**
2. Service kholo -> **Variables** me ye 4 daalo:
   - `MONGODB_URI` = Atlas wali string
   - `JWT_SECRET` = koi lamba random text
   - `ADMIN_EMAIL` = apna admin email
   - `ADMIN_PASSWORD` = mazboot password
3. **Settings** me dekho:
   - Build Command: `npm run build`
   - Start Command: `npm start`
   (Railway aksar khud pakad leta hai. Na kare to yahan khud likh do.)
4. **Settings** -> **Networking** -> **Generate Domain**. Jo link mile wahi aapki website hai.
5. **Deployments** -> latest -> **View logs** me ye aana chahiye:
   ```
   Chat running on port ... (website + API + Socket.io)
   ✓ MongoDB connected
   ```
6. Browser me `https://aapka-link.up.railway.app/api/health` kholo: 4 cheezein `true` dikhni chahiye.
7. Phir `https://aapka-link.up.railway.app` kholo, sign up karo. Admin ke liye `ADMIN_EMAIL` aur `ADMIN_PASSWORD` se isi login page se login karo.

Variables badalne ke baad Railway khud dobara deploy karta hai.

## Local chalana
1. `.env.example` ko copy karke `.env` banao aur 4 values bharo.
2. `npm install`
3. `npm run dev` -> http://localhost:5173 kholo (API + Socket.io 3000 par chalte hain, Vite khud jod deta hai).
4. Railway jaisa test: `npm run build` phir `npm start` -> http://localhost:3000

## Masle aaye to
| Dikhta hai | Wajah / hal |
|---|---|
| Logs me `Missing environment variables` | Railway Variables me wo naam daalo |
| `The website is not built yet` | Build Command `npm run build` hona chahiye |
| `MongoDB connection failed` | Atlas me `0.0.0.0/0`, ya URI/password ghalat |
| Chat page par peeli "Reconnecting…" patti | Socket.io connect nahi hua. Page refresh karo, phir bhi ho to Logs dekho |
| Login par "Could not connect to the database" | upar wali wajah. Asli reason ke liye Variables me `SHOW_ERRORS` = `1` daalo, phir hata do |

## Limits
- Files MongoDB me save hoti hain (`MAX_UPLOAD_MB`, default 10). Free Atlas 512 MB ka hota hai.
- Calls ko HTTPS chahiye (Railway par hota hai). Kuch networks par TURN server bhi (`TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`).
- Features: reactions, reply, edit/delete, photo/video/files, voice message, emoji picker, calls, dark/light theme, admin panel.
