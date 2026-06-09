const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.VSTI_TOKEN || "VSTI_MIDDLEWARE_2026_8fK92sLq_7pX41z";

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "VS&TI Device Middleware",
    message: "Use POST /endpoint with valid token"
  });
});

app.post("/endpoint", (req, res) => {
  const token = req.query.token || req.headers["x-vsti-token"];

  if (token !== TOKEN) {
    return res.status(401).json({
      status: "error",
      message: "Unauthorized"
    });
  }

  const now = new Date();

  const chileTime = now.toLocaleString("sv-SE", {
    timeZone: "America/Santiago"
  });

  const date = chileTime.split(" ")[0];

  const logDir = path.join(__dirname, "logs");

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const logFile = path.join(logDir, `VSTI_device_data_${date}.log`);

  const entry = {
    received_at: chileTime,
    remote_ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    user_agent: req.headers["user-agent"] || null,
    content_type: req.headers["content-type"] || null,
    payload: req.body
  };

  fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");

  res.status(200).json({
    status: "ok",
    message: "Device data received",
    received_at: chileTime
  });
});

app.listen(PORT, () => {
  console.log(`VS&TI Device Middleware running on port ${PORT}`);
});  
