const express = require("express");
const cors = require("cors");
const db = require("./config/db");

const authRoutes = require("./routes/auth");
const vehicleRoutes = require("./routes/vehicles");
const auctionRoutes = require("./routes/auctions");

const authenticateToken = require("./middleware/authMiddleware");

const app = express();


// ===============================
// MIDDLEWARE
// ===============================

app.use(cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// ===============================
// PORT
// ===============================

const PORT = 5000;


// ===============================
// API ROUTES
// ===============================

app.use("/api/auth", authRoutes);
app.use("/api/vehicles", vehicleRoutes);
app.use("/api/auctions", auctionRoutes);


// ===============================
// BASIC TEST ROUTE
// ===============================

app.get("/", (req, res) => {
    res.send("Bid My Car Backend is running!");
});


// ===============================
// API TEST
// ===============================

app.get("/api/test", (req, res) => {
    res.json({
        success: true,
        message: "Bid My Car API is working!"
    });
});


// ===============================
// PROTECTED ROUTE TEST
// ===============================

app.get("/api/protected", authenticateToken, (req, res) => {
    res.json({
        success: true,
        message: "You accessed a protected route!",
        user: req.user
    });
});


// ===============================
// DATABASE TEST
// ===============================

app.get("/api/db-test", async (req, res) => {

    try {

        const [result] = await db.query(
            "SELECT 1 AS test"
        );

        res.json({
            success: true,
            message: "MySQL database connected successfully!",
            result: result
        });

    } catch (error) {

        console.error("Database error:", error);

        res.status(500).json({
            success: false,
            message: "Database connection failed!",
            error: error.message
        });
    }
});


// ===============================
// START SERVER
// ===============================

app.listen(PORT, () => {

    console.log(
        `Bid My Car backend running on http://localhost:${PORT}`
    );

});