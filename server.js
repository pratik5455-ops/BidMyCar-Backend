const express = require("express");
const cors = require("cors");
const db = require("./config/db");
const { startAuctionSettlementWorker } = require("./services/auctionSettlementService");
const authRoutes = require("./routes/auth");
const vehicleRoutes = require("./routes/vehicles");
const auctionRoutes = require("./routes/auctions");
const authenticateToken = require("./middleware/authMiddleware");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = 5000;

function validateStrongPassword(req, res, next) {
    const password = req.body?.password;

    if (typeof password !== "string" || password.length < 8) {
        return res.status(400).json({
            success: false,
            message: "Password must be at least 8 characters long"
        });
    }

    const hasUppercase = /[A-Z]/.test(password);
    const hasLowercase = /[a-z]/.test(password);
    const hasSpecial = /[^A-Za-z0-9\s]/.test(password);

    if (!hasUppercase || !hasLowercase || !hasSpecial) {
        return res.status(400).json({
            success: false,
            message: "Password must contain at least 8 characters, one uppercase letter, one lowercase letter and one special character"
        });
    }

    next();
}

app.use("/api/auth/register", validateStrongPassword);
app.use("/api/auth/reset-password", validateStrongPassword);

app.use("/api/auth", authRoutes);
app.use("/api/vehicles", vehicleRoutes);

// Public auction feed used by the frontend to map vehicles to real auction IDs.
app.get("/api/auctions", async (req, res) => {
    try {
        const [auctions] = await db.query(`
            SELECT
                a.*,
                v.title AS vehicle_title,
                v.make,
                v.model,
                v.year,
                v.category,
                v.primary_damage,
                v.secondary_damage,
                v.current_bid AS vehicle_current_bid,
                v.sale_status,
                v.seller_id
            FROM auctions a
            INNER JOIN vehicles v ON a.vehicle_id = v.id
            ORDER BY a.start_time ASC
        `);

        return res.status(200).json({
            success: true,
            count: auctions.length,
            auctions
        });
    } catch (error) {
        console.error("Get public auctions error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch auctions"
        });
    }
});

app.use("/api/auctions", auctionRoutes);

app.get("/", (req, res) => {
    res.send("Bid My Car Backend is running!");
});

app.get("/api/test", (req, res) => {
    res.json({ success: true, message: "Bid My Car API is working!" });
});

app.get("/api/protected", authenticateToken, (req, res) => {
    res.json({
        success: true,
        message: "You accessed a protected route!",
        user: req.user
    });
});

app.get("/api/db-test", async (req, res) => {
    try {
        const [result] = await db.query("SELECT 1 AS test");
        res.json({
            success: true,
            message: "MySQL database connected successfully!",
            result
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

app.listen(PORT, () => {
    console.log(`Server started successfully on port ${PORT}`);
    startAuctionSettlementWorker();
});
