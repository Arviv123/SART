# 🚀 Server Bridge API - הוראות פריסה

## פריסה ב-Render.com (מומלץ)

1. **העלה לGitLab:**
   ```bash
   git add .
   git commit -m "Ready for deployment"
   git push origin main
   ```

2. **פרוס ב-Render:**
   - לך ל-https://dashboard.render.com
   - New → Web Service
   - Connect GitLab repository
   - Render יזהה את `render.yaml` אוטומטית

3. **קבל את הפרטים:**
   - URL: `https://your-service.onrender.com`
   - API Key: `your-super-secret-api-key-123`

## פריסה עם Docker

```bash
# בניית Docker image
docker build -t server-bridge-api .

# הרצה עם Docker
docker run -p 10000:10000 \
  -e API_KEY=your-super-secret-api-key-123 \
  server-bridge-api

# או עם docker-compose
docker-compose up -d
```

## פריסה בשרת עם PM2

```bash
# התקנת PM2
npm install -g pm2

# הרצת השרת
pm2 start server.js --name "server-bridge"
pm2 save
pm2 startup
```

## בדיקת הפעלה

```bash
# בדיקת health
curl https://your-server.com/health

# תשובה צפויה:
# {"status":"healthy","timestamp":"...","uptime":...}
```

## 🔑 פרטי גישה

- **API Key:** `your-super-secret-api-key-123`
- **Port:** `10000`
- **Authentication:** `Authorization: Bearer your-super-secret-api-key-123`

## 📋 API Endpoints

- `GET /health` - בדיקת תקינות
- `GET /servers` - רשימת שרתים
- `POST /servers` - יצירת שרת חדש
- `POST /servers/:id/execute` - ביצוע פקודות
- `GET /servers/:id/files` - רשימת קבצים
- `POST /servers/:id/files` - יצירה/עריכת קבצים

## 🛡️ אבטחה

השרת כולל:
- ✅ אימות API Key
- ✅ בדיקת נתיבים (Path Traversal Protection)
- ✅ הגבלת גישה לתיקיות שרתים
- ✅ CORS Protection