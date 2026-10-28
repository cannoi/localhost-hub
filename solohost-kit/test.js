const http = require("http");

const port = process.env.PORT || 8080;

function verifyHealth(retries = 5, delay = 500) {
  const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
    let data = "";
    res.on("data", (chunk) => {
      data += chunk;
    });
    res.on("end", () => {
      if (res.statusCode >= 200 && res.statusCode < 400) {
        console.log(`Health check passed with HTTP status ${res.statusCode}: ${data}`);
        process.exit(0);
      }
      console.error(`Health check failed: ${res.statusCode} ${data}`);
      process.exit(1);
    });
  });
  req.on("error", (err) => {
    if (retries > 0) {
      setTimeout(() => verifyHealth(retries - 1, delay), delay);
      return;
    }
    console.error(`Health check connection error: ${err.message}`);
    process.exit(1);
  });
}

verifyHealth();
