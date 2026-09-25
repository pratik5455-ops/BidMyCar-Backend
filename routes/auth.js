const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const db = require("../config/db");
const authenticateToken = require("../middleware/authMiddleware");
const sendVerificationEmail = require("../services/emailService");
const sendPasswordResetEmail = require("../services/passwordResetEmail");
const router = express.Router();


// ======================================================
// REGISTER
// POST /api/auth/register
// ======================================================

router.post("/register", async (req, res) => {
    try {
        const { name, email, password } = req.body;

        // Check required fields
        if (!name || !email || !password) {
            return res.status(400).json({
                success: false,
                message: "Name, email and password are required"
            });
        }

        // Clean email
        const cleanEmail = email.trim().toLowerCase();

        // Validate email
        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!emailPattern.test(cleanEmail)) {
            return res.status(400).json({
                success: false,
                message: "Please enter a valid email address"
            });
        }

        // Check if email already exists
        const [existingUser] = await db.query(
            "SELECT id FROM users WHERE email = ?",
            [cleanEmail]
        );

        if (existingUser.length > 0) {
            return res.status(409).json({
                success: false,
                message: "Email is already registered"
            });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Generate secure random verification token
        const verificationToken = crypto.randomBytes(32).toString("hex");

        // Token expires after 24 hours
        const verificationExpires = new Date(
            Date.now() + 24 * 60 * 60 * 1000
        );

        // Insert user into database
        const [result] = await db.query(
            `INSERT INTO users
            (name, email, password, verification_token, verification_expires)
            VALUES (?, ?, ?, ?, ?)`,
            [
                name,
                cleanEmail,
                hashedPassword,
                verificationToken,
                verificationExpires
            ]
        );

        // Create verification link
        const verificationLink =
            `http://localhost:5000/api/auth/verify-email?token=${verificationToken}`;

        // Send verification email
        await sendVerificationEmail(
            cleanEmail,
            verificationLink
        );

        // Registration successful
        res.status(201).json({
            success: true,
            message: "Registration successful. Please check your email to verify your account.",
            userId: result.insertId
        });

    } catch (error) {
        console.error("Registration error:", error);

        res.status(500).json({
            success: false,
            message: "Registration failed"
        });
    }
});
// ======================================================
// FORGOT PASSWORD
// POST /api/auth/forgot-password
// ======================================================

router.post("/forgot-password", async (req, res) => {
    try {
        const { email } = req.body;

        // Check if email was provided
        if (!email) {
            return res.status(400).json({
                success: false,
                message: "Email is required"
            });
        }

        // Clean email
        const cleanEmail = email.trim().toLowerCase();

        // Validate email
        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!emailPattern.test(cleanEmail)) {
            return res.status(400).json({
                success: false,
                message: "Please enter a valid email address"
            });
        }

        // Find user by email
        const [users] = await db.query(
            "SELECT id, email FROM users WHERE email = ?",
            [cleanEmail]
        );

        // User not found
        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No account found with this email address"
            });
        }

        const user = users[0];

        // Generate secure random reset token
        const resetToken = crypto.randomBytes(32).toString("hex");

        // Token expires after 1 hour
        const resetExpires = new Date(
            Date.now() + 60 * 60 * 1000
        );

        // Store reset token in database
        await db.query(
            `UPDATE users
             SET password_reset_token = ?,
                 password_reset_expires = ?
             WHERE id = ?`,
            [
                resetToken,
                resetExpires,
                user.id
            ]
        );

        // Create password reset link
        const resetLink =
            `http://localhost:5000/api/auth/reset-password?token=${resetToken}`;


        // Send password reset email
    await sendPasswordResetEmail(
    cleanEmail,
    resetLink
);

        // Success response
        res.status(200).json({
            success: true,
            message: "Password reset link has been sent to your email"
        });

    } catch (error) {
        console.error("Forgot password error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to process password reset request"
        });
    }
});
// ======================================================
// RESET PASSWORD PAGE
// GET /api/auth/reset-password?token=...
// ======================================================

router.get("/reset-password", async (req, res) => {
    try {
        const { token } = req.query;

        // Check if token was provided
        if (!token) {
            return res.status(400).send(
                "Password reset token is required."
            );
        }

        // Find user with this reset token
        const [users] = await db.query(
            `SELECT id, password_reset_expires
             FROM users
             WHERE password_reset_token = ?`,
            [token]
        );

        // Token not found
        if (users.length === 0) {
            return res.status(400).send(
                "Invalid or expired password reset link."
            );
        }

        const user = users[0];

        // Check token expiry
        if (
            !user.password_reset_expires ||
            new Date() > new Date(user.password_reset_expires)
        ) {
            return res.status(400).send(
                "This password reset link has expired."
            );
        }

        // Show password reset form
        res.send(`
            <!DOCTYPE html>
            <html>
                <head>
                    <title>Reset Password - Bid My Car</title>
                </head>

                <body style="
                    font-family: Arial, sans-serif;
                    background: #f5f5f5;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    min-height: 100vh;
                    margin: 0;
                ">

                    <div style="
                        background: white;
                        padding: 30px;
                        width: 350px;
                        border-radius: 10px;
                        box-shadow: 0 4px 15px rgba(0,0,0,0.1);
                    ">

                        <h2 style="text-align:center;">
                            Reset Your Password
                        </h2>

                        <form method="POST"
                              action="/api/auth/reset-password">

                            <input
                                type="hidden"
                                name="token"
                                value="${token}"
                            >

                            <label>
                                New Password
                            </label>

                            <input
                                type="password"
                                name="password"
                                required
                                minlength="8"
                                style="
                                    width:100%;
                                    padding:10px;
                                    margin:8px 0 15px;
                                    box-sizing:border-box;
                                "
                            >

                            <label>
                                Confirm Password
                            </label>

                            <input
                                type="password"
                                name="confirmPassword"
                                required
                                minlength="8"
                                style="
                                    width:100%;
                                    padding:10px;
                                    margin:8px 0 20px;
                                    box-sizing:border-box;
                                "
                            >

                            <button
                                type="submit"
                                style="
                                    width:100%;
                                    padding:12px;
                                    background:#000;
                                    color:white;
                                    border:none;
                                    border-radius:5px;
                                    cursor:pointer;
                                "
                            >
                                Reset Password
                            </button>

                        </form>

                    </div>

                </body>
            </html>
        `);

    } catch (error) {
        console.error("Reset password page error:", error);

        res.status(500).send(
            "Unable to open password reset page."
        );
    }
});
// ======================================================
// RESET PASSWORD
// POST /api/auth/reset-password
// ======================================================

router.post("/reset-password", async (req, res) => {
    try {
        const { token, password, confirmPassword } = req.body;

        // Check required fields
        if (!token || !password || !confirmPassword) {
            return res.status(400).json({
                success: false,
                message: "Token, password and confirm password are required"
            });
        }

        // Check password length
        if (password.length < 8) {
            return res.status(400).json({
                success: false,
                message: "Password must be at least 8 characters long"
            });
        }

        // Check if passwords match
        if (password !== confirmPassword) {
            return res.status(400).json({
                success: false,
                message: "Passwords do not match"
            });
        }

        // Find user with this reset token
        const [users] = await db.query(
            `SELECT id, email, password_reset_expires
             FROM users
             WHERE password_reset_token = ?`,
            [token]
        );

        // Token not found
        if (users.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid or expired password reset link"
            });
        }

        const user = users[0];

        // Check token expiry
        if (
            !user.password_reset_expires ||
            new Date() > new Date(user.password_reset_expires)
        ) {
            return res.status(400).json({
                success: false,
                message: "This password reset link has expired"
            });
        }

        // Hash the new password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Update password and clear reset token
        await db.query(
            `UPDATE users
             SET password = ?,
                 password_reset_token = NULL,
                 password_reset_expires = NULL
             WHERE id = ?`,
            [
                hashedPassword,
                user.id
            ]
        );

        // Password reset successful
        res.status(200).json({
            success: true,
            message: "Password has been reset successfully. You can now log in."
        });

    } catch (error) {
        console.error("Reset password error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to reset password"
        });
    }
});
// ======================================================
// LOGIN
// POST /api/auth/login
// ======================================================

router.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        // Check required fields
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: "Email and password are required"
            });
        }

        // Clean email
        const cleanEmail = email.trim().toLowerCase();

        // Validate email
        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!emailPattern.test(cleanEmail)) {
            return res.status(400).json({
                success: false,
                message: "Please enter a valid email address"
            });
        }

        // Find user by email
        const [users] = await db.query(
            "SELECT id, name, email, password, role, email_verified FROM users WHERE email = ?",
            [cleanEmail]
        );

        // User not found
        if (users.length === 0) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password"
            });
        }

        const user = users[0];

        // Compare entered password with stored bcrypt hash
        const passwordMatch = await bcrypt.compare(
            password,
            user.password
        );

        // Password is incorrect
        if (!passwordMatch) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password"
            });
        }

        // Check email verification
        if (!user.email_verified) {
            return res.status(403).json({
                success: false,
                message: "Please verify your email before logging in"
            });
        }

        // Create JWT token
        const token = jwt.sign(
            {
                userId: user.id,
                email: user.email,
                role: user.role
            },
            process.env.JWT_SECRET,
            {
                expiresIn: "1h"
            }
        );

        // Login successful
        res.status(200).json({
            success: true,
            message: "Login successful",
            token: token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role
            }
        });

    } catch (error) {
        console.error("Login error:", error);

        res.status(500).json({
            success: false,
            message: "Login failed"
        });
    }
});


// ======================================================
// VERIFY EMAIL
// GET /api/auth/verify-email?token=...
// ======================================================

router.get("/verify-email", async (req, res) => {
    try {
        const { token } = req.query;

        // Check if token was provided
        if (!token) {
            return res.status(400).send(
                "Verification token is required."
            );
        }

        // Find user with this verification token
        const [users] = await db.query(
            `SELECT id, email, email_verified, verification_expires
             FROM users
             WHERE verification_token = ?`,
            [token]
        );

        // Token not found
        if (users.length === 0) {
            return res.status(400).send(
                "Invalid verification link."
            );
        }

        const user = users[0];

        // Already verified
        if (user.email_verified) {
            return res.send(
                "Your email is already verified. You can log in to Bid My Car."
            );
        }

        // Check token expiry
        if (
            !user.verification_expires ||
            new Date() > new Date(user.verification_expires)
        ) {
            return res.status(400).send(
                "This verification link has expired. Please request a new verification email."
            );
        }

        // Mark email as verified
        await db.query(
            `UPDATE users
             SET email_verified = TRUE,
                 verification_token = NULL,
                 verification_expires = NULL
             WHERE id = ?`,
            [user.id]
        );

        // Verification successful
        res.send(`
            <html>
                <head>
                    <title>Email Verified - Bid My Car</title>
                </head>

                <body style="
                    font-family: Arial, sans-serif;
                    text-align: center;
                    padding: 60px;
                ">

                    <h1>Email Verified Successfully!</h1>

                    <p>
                        Your Bid My Car account has been verified.
                    </p>

                    <p>
                        You can now log in to your account.
                    </p>

                </body>
            </html>
        `);

    } catch (error) {
        console.error("Email verification error:", error);

        res.status(500).send(
            "Email verification failed."
        );
    }
});


// ======================================================
// GET CURRENT USER
// GET /api/auth/me
// ======================================================

router.get("/me", authenticateToken, async (req, res) => {
    try {
        const [users] = await db.query(
            "SELECT id, name, email, role FROM users WHERE id = ?",
            [req.user.userId]
        );

        // User no longer exists
        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        const user = users[0];

        res.status(200).json({
            success: true,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role
            }
        });

    } catch (error) {
        console.error("Get user error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to get user information"
        });
    }
});


module.exports = router;