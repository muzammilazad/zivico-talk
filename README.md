# Zivico Talk

Private WhatsApp-like communication app with React, Vite, Node.js, Express, Socket.IO, JWT auth, MySQL/Prisma persistence, uploads, media messages, voice notes, and Agora voice/video calls.

## Features

- Register/login with bcrypt password hashing and JWT expiry
- Accepted contacts and contact requests
- Realtime one-to-one chat with sent, delivered, and read status
- Unread badges and online/offline presence
- Image, file, and voice-note messages
- Profile avatar uploads
- Cross-platform Agora voice and video calls
- Call events in the chat timeline

## Backend Setup

```bash
cd backend
npm install
copy .env.example .env
```

Edit `backend/.env`:

```env
DATABASE_URL="mysql://root:YOUR_PASSWORD@localhost:3306/zivico_talk"
JWT_SECRET="replace-with-long-random-secret"
PORT=4000
FRONTEND_URL="http://localhost:5173"
```

Create the MySQL database in MySQL Workbench:

1. Open MySQL Workbench.
2. Connect to your local MySQL server.
3. Run:

```sql
CREATE DATABASE zivico_talk;
```

4. Update `backend/.env` with the correct MySQL username and password.

Then run:

```bash
npm install prisma @prisma/client
npx prisma init
npx prisma migrate dev --name init
npx prisma generate
npm run dev
```

Useful Prisma commands:

```bash
npm install prisma @prisma/client
npx prisma init
npx prisma migrate dev --name init
npx prisma generate
```

## Frontend Setup

In a second terminal:

```bash
cd frontend
npm install
copy .env.example .env
npm run dev
```

Open `http://localhost:5173`.

Add the same Agora App ID used by the Flutter app to `frontend/.env`:

```env
VITE_AGORA_APP_ID="a84361a1dca0421dafc488d41619a153"
```

Agora calls use RTC tokens issued by the backend. Keep the App Certificate only in the backend environment.

## Testing With Two Users

1. Register user 1.
2. Register user 2 in another browser or private window.
3. User 1 searches user 2 by email or phone and sends a contact request.
4. User 2 accepts the request.
5. Send text, image, file, and voice-note messages.
6. Try voice and video calls between web and Flutter using the same Agora App ID.
7. Refresh the browser and restart the backend to confirm history persists in MySQL.

## API Highlights

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/contacts`
- `GET /api/users/search?q=`
- `POST /api/contact-requests`
- `GET /api/contact-requests`
- `POST /api/contact-requests/:requestId/accept`
- `POST /api/contact-requests/:requestId/reject`
- `GET /api/conversations/:userId/timeline`
- `POST /api/call-events`
- `POST /api/uploads`

Uploaded files are stored in `backend/uploads/` and served from `/uploads/:filename`.

## Troubleshooting

- `DATABASE_URL invalid`: confirm MySQL is running, the database exists, and `.env` uses the right username/password.
- `port already in use`: change `PORT` in `backend/.env` or stop the process using port `4000`.
- Windows port check:
  ```bat
  netstat -ano | findstr :4000
  ```
- Windows kill process:
  ```bat
  taskkill /PID <PID> /F
  ```
- `uploads folder missing`: the backend creates `backend/uploads/` automatically on start/upload.
- `CORS issue`: make sure `FRONTEND_URL` matches the frontend URL, usually `http://localhost:5173`.
- Prisma client errors: run `npm run prisma:generate` after changing `prisma/schema.prisma`.
- `Agora App ID missing`: set `VITE_AGORA_APP_ID` in `frontend/.env` to the Flutter app's App ID.
- `Unable to get Agora token from server`: verify the backend Agora environment variables and deployment.
- Calls ring but media does not connect: confirm both clients received the exact same `channelName`, use different UIDs, and use the same token mode.

## Same Network Testing

The backend binds to `0.0.0.0:4000` and the frontend dev server binds to `0.0.0.0:5173`.

On another device on the same network:

- Set `frontend/.env` to `VITE_API_URL=http://YOUR_COMPUTER_LAN_IP:4000`
- Open `http://YOUR_COMPUTER_LAN_IP:5173`

Browsers require HTTPS for microphone and camera access outside `localhost`.
