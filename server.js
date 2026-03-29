const express = require("express");
const app = express();

// test route
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    message: "Server is running 🚀"
  });
});

// sample news route (temporary)
app.get("/api/news", (req, res) => {
  res.json([
    {
      title: "Sample Tech News",
      description: "This is a test news item",
      url: "https://example.com"
    }
  ]);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
