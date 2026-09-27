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
// HELPERS
// ======================================================

// Email validation
function isValidEmail(email) {
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailPattern.test(email);
}


// Indian phone validation
// Accepts:
// 9876543210
// +919876543210
// 919876543210
function normalizePhone(phone) {

    if (!phone) {
        return null;
    }

    let cleanPhone = String(phone)
        .trim()
        .replace(/[\s()-]/g, "");

    // Convert +91XXXXXXXXXX
    if (cleanPhone.startsWith("+91")) {
        cleanPhone = cleanPhone.substring(3);
    }

    // Convert 91XXXXXXXXXX
    if (
        cleanPhone.startsWith("91") &&
        cleanPhone.length === 12
    ) {
        cleanPhone = cleanPhone.substring(2);
    }

    // Must be exactly 10 digits
    if (!/^[6-9]\d{9}$/.test(cleanPhone)) {
        return null;
    }

    // Store internally in a consistent format
    return `+91${cleanPhone}`;
}


// ======================================================
// REGISTER
// POST /api/auth/register
// ======================================================

router.post("/register", async (req, res) => {

    try {

        const {
            name,
            email,
            phone,
            password
        } = req.body;


        // --------------------------------------------------
        // REQUIRED FIELDS
        // --------------------------------------------------

        if (
            !name ||
            !email ||
            !phone ||
            !password
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "Name, email, phone number and password are required"
            });
        }


        // --------------------------------------------------
        // CLEAN INPUT
        // --------------------------------------------------

        const cleanName = name.trim();
        const cleanEmail = email.trim().toLowerCase();

        const cleanPhone = normalizePhone(phone);


        // --------------------------------------------------
        // NAME VALIDATION
        // --------------------------------------------------

        if (cleanName.length < 2) {

            return res.status(400).json({
                success: false,
                message: "Please enter a valid name"
            });
        }


        // --------------------------------------------------
        // EMAIL VALIDATION
        // --------------------------------------------------

        if (!isValidEmail(cleanEmail)) {

            return res.status(400).json({
                success: false,
                message:
                    "Please enter a valid email address"
            });
        }


        // --------------------------------------------------
        // PHONE VALIDATION
        // --------------------------------------------------

        if (!cleanPhone) {

            return res.status(400).json({
                success: false,
                message:
                    "Please enter a valid Indian mobile number"
            });
        }


        // --------------------------------------------------
        // PASSWORD VALIDATION
        // --------------------------------------------------

        if (password.length < 8) {

            return res.status(400).json({
                success: false,
                message:
                    "Password must be at least 8 characters long"
            });
        }


        // --------------------------------------------------
        // CHECK DUPLICATE EMAIL
        // --------------------------------------------------

        const [existingUser] = await db.query(
            "SELECT id FROM users WHERE email = ?",
            [cleanEmail]
        );


        if (existingUser.length > 0) {

            return res.status(409).json({
                success: false,
                message:
                    "Email is already registered"
            });
        }


        // --------------------------------------------------
        // HASH PASSWORD
        // --------------------------------------------------

        const hashedPassword =
            await bcrypt.hash(password, 10);


        // --------------------------------------------------
        // CREATE EMAIL VERIFICATION TOKEN
        // --------------------------------------------------

        const verificationToken =
            crypto.randomBytes(32).toString("hex");


        // Token expires after 24 hours
        const verificationExpires =
            new Date(
                Date.now() +
                24 * 60 * 60 * 1000
            );


        // --------------------------------------------------
        // INSERT USER
        // --------------------------------------------------

        const [result] = await db.query(

            `INSERT INTO users
            (
                name,
                email,
                phone,
                password,
                verification_token,
                verification_expires
            )
            VALUES (?, ?, ?, ?, ?, ?)`,
            
            [
                cleanName,
                cleanEmail,
                cleanPhone,
                hashedPassword,
                verificationToken,
                verificationExpires
            ]
        );


        // --------------------------------------------------
        // CREATE VERIFICATION LINK
        // --------------------------------------------------

        const verificationLink =
            `http://localhost:5000/api/auth/verify-email?token=${verificationToken}`;


        // --------------------------------------------------
        // SEND VERIFICATION EMAIL
        // --------------------------------------------------

        await sendVerificationEmail(
            cleanEmail,
            verificationLink
        );


        // --------------------------------------------------
        // SUCCESS
        // --------------------------------------------------

        return res.status(201).json({

            success: true,

            message:
                "Registration successful. Please check your email to verify your account.",

            userId: result.insertId

        });

    } catch (error) {

        console.error(
            "Registration error:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                "Registration failed"
        });
    }
});


// ======================================================
// FORGOT PASSWORD
// POST /api/auth/forgot-password
// ======================================================

router.post(
    "/forgot-password",
    async (req, res) => {

        try {

            const { email } = req.body;


            if (!email) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Email is required"
                });
            }


            const cleanEmail =
                email.trim().toLowerCase();


            if (!isValidEmail(cleanEmail)) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please enter a valid email address"
                });
            }


            // --------------------------------------------------
            // FIND USER
            // --------------------------------------------------

            const [users] = await db.query(

                `SELECT id, email
                 FROM users
                 WHERE email = ?`,

                [cleanEmail]
            );


            if (users.length === 0) {

                return res.status(404).json({
                    success: false,
                    message:
                        "No account found with this email address"
                });
            }


            const user = users[0];


            // --------------------------------------------------
            // GENERATE RESET TOKEN
            // --------------------------------------------------

            const resetToken =
                crypto.randomBytes(32).toString("hex");


            const resetExpires =
                new Date(
                    Date.now() +
                    60 * 60 * 1000
                );


            // --------------------------------------------------
            // SAVE RESET TOKEN
            // --------------------------------------------------

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


            // --------------------------------------------------
            // RESET LINK
            // --------------------------------------------------

            const resetLink =
                `http://localhost:5000/api/auth/reset-password?token=${resetToken}`;


            // --------------------------------------------------
            // SEND EMAIL
            // --------------------------------------------------

            await sendPasswordResetEmail(
                cleanEmail,
                resetLink
            );


            return res.status(200).json({

                success: true,

                message:
                    "Password reset link has been sent to your email"

            });

        } catch (error) {

            console.error(
                "Forgot password error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Failed to process password reset request"
            });
        }
    }
);


// ======================================================
// RESET PASSWORD PAGE
// GET /api/auth/reset-password?token=...
// ======================================================

router.get(
    "/reset-password",
    async (req, res) => {

        try {

            const { token } = req.query;


            if (!token) {

                return res.status(400).send(
                    "Password reset token is required."
                );
            }


            const [users] = await db.query(

                `SELECT
                    id,
                    password_reset_expires
                 FROM users
                 WHERE password_reset_token = ?`,

                [token]
            );


            if (users.length === 0) {

                return res.status(400).send(
                    "Invalid or expired password reset link."
                );
            }


            const user = users[0];


            // --------------------------------------------------
            // CHECK EXPIRY
            // --------------------------------------------------

            if (
                !user.password_reset_expires ||
                new Date() >
                new Date(user.password_reset_expires)
            ) {

                return res.status(400).send(
                    "This password reset link has expired."
                );
            }


            // --------------------------------------------------
            // PASSWORD RESET PAGE
            // --------------------------------------------------

            res.send(`

                <!DOCTYPE html>

                <html>

                <head>

                    <meta charset="UTF-8">

                    <meta
                        name="viewport"
                        content="width=device-width, initial-scale=1.0"
                    >

                    <title>
                        Reset Password - Bid My Car
                    </title>

                </head>


                <body style="
                    font-family: Arial, sans-serif;
                    background: #061827;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    min-height: 100vh;
                    margin: 0;
                ">


                    <div style="
                        background: #0B2235;
                        color: white;
                        padding: 30px;
                        width: 350px;
                        border-radius: 15px;
                        box-shadow: 0 10px 40px rgba(0,0,0,0.4);
                    ">


                        <h2 style="
                            text-align:center;
                            margin-top:0;
                        ">

                            Reset Your Password

                        </h2>


                        <form
                            method="POST"
                            action="/api/auth/reset-password"
                        >


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
                                    background:#087CFF;
                                    color:white;
                                    border:none;
                                    border-radius:8px;
                                    cursor:pointer;
                                    font-weight:bold;
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

            console.error(
                "Reset password page error:",
                error
            );

            res.status(500).send(
                "Unable to open password reset page."
            );
        }
    }
);


// ======================================================
// RESET PASSWORD
// POST /api/auth/reset-password
// ======================================================

router.post(
    "/reset-password",
    async (req, res) => {

        try {

            const {
                token,
                password,
                confirmPassword
            } = req.body;


            if (
                !token ||
                !password ||
                !confirmPassword
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Token, password and confirm password are required"
                });
            }


            if (password.length < 8) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Password must be at least 8 characters long"
                });
            }


            if (
                password !==
                confirmPassword
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Passwords do not match"
                });
            }


            const [users] = await db.query(

                `SELECT
                    id,
                    password_reset_expires
                 FROM users
                 WHERE password_reset_token = ?`,

                [token]
            );


            if (users.length === 0) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid or expired password reset link"
                });
            }


            const user = users[0];


            if (
                !user.password_reset_expires ||
                new Date() >
                new Date(user.password_reset_expires)
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "This password reset link has expired"
                });
            }


            // --------------------------------------------------
            // HASH NEW PASSWORD
            // --------------------------------------------------

            const hashedPassword =
                await bcrypt.hash(password, 10);


            // --------------------------------------------------
            // UPDATE PASSWORD
            // --------------------------------------------------

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


            return res.status(200).json({

                success: true,

                message:
                    "Password has been reset successfully. You can now log in."

            });

        } catch (error) {

            console.error(
                "Reset password error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Failed to reset password"
            });
        }
    }
);


// ======================================================
// LOGIN
// POST /api/auth/login
// ======================================================

router.post(
    "/login",
    async (req, res) => {

        try {

            const {
                email,
                password
            } = req.body;


            if (!email || !password) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Email and password are required"
                });
            }


            const cleanEmail =
                email.trim().toLowerCase();


            if (!isValidEmail(cleanEmail)) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please enter a valid email address"
                });
            }


            // --------------------------------------------------
            // FIND USER
            // --------------------------------------------------

            const [users] = await db.query(

                `SELECT
                    id,
                    name,
                    email,
                    password,
                    role,
                    email_verified
                 FROM users
                 WHERE email = ?`,

                [cleanEmail]
            );


            if (users.length === 0) {

                return res.status(401).json({
                    success: false,
                    message:
                        "Invalid email or password"
                });
            }


            const user = users[0];


            // --------------------------------------------------
            // CHECK PASSWORD
            // --------------------------------------------------

            const passwordMatch =
                await bcrypt.compare(
                    password,
                    user.password
                );


            if (!passwordMatch) {

                return res.status(401).json({
                    success: false,
                    message:
                        "Invalid email or password"
                });
            }


            // --------------------------------------------------
            // CHECK EMAIL VERIFICATION
            // --------------------------------------------------

            if (!user.email_verified) {

                return res.status(403).json({
                    success: false,
                    message:
                        "Please verify your email before logging in"
                });
            }


            // --------------------------------------------------
            // CREATE JWT
            // --------------------------------------------------

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


            // --------------------------------------------------
            // LOGIN RESPONSE
            //
            // IMPORTANT:
            // PHONE IS INTENTIONALLY NOT RETURNED.
            // --------------------------------------------------

            return res.status(200).json({

                success: true,

                message:
                    "Login successful",

                token: token,

                user: {

                    id: user.id,

                    name: user.name,

                    email: user.email,

                    role: user.role

                }

            });

        } catch (error) {

            console.error(
                "Login error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Login failed"
            });
        }
    }
);


// ======================================================
// VERIFY EMAIL
// GET /api/auth/verify-email?token=...
// ======================================================

router.get(
    "/verify-email",
    async (req, res) => {

        try {

            const { token } = req.query;


            if (!token) {

                return res.status(400).send(
                    "Verification token is required."
                );
            }


            const [users] = await db.query(

                `SELECT
                    id,
                    email,
                    email_verified,
                    verification_expires
                 FROM users
                 WHERE verification_token = ?`,

                [token]
            );


            if (users.length === 0) {

                return res.status(400).send(
                    "Invalid verification link."
                );
            }


            const user = users[0];


            // --------------------------------------------------
            // ALREADY VERIFIED
            // --------------------------------------------------

            if (user.email_verified) {

                return res.send(`

                    <html>

                    <head>
                        <title>
                            Email Already Verified
                        </title>
                    </head>

                    <body style="
                        font-family:Arial;
                        text-align:center;
                        padding:60px;
                    ">

                        <h1>
                            Email Already Verified
                        </h1>

                        <p>
                            Your Bid My Car account is already verified.
                        </p>

                        <p>
                            You can now log in.
                        </p>

                    </body>

                    </html>

                `);
            }


            // --------------------------------------------------
            // CHECK TOKEN EXPIRY
            // --------------------------------------------------

            if (
                !user.verification_expires ||
                new Date() >
                new Date(user.verification_expires)
            ) {

                return res.status(400).send(
                    "This verification link has expired. Please request a new verification email."
                );
            }


            // --------------------------------------------------
            // VERIFY USER
            // --------------------------------------------------

            await db.query(

                `UPDATE users
                 SET email_verified = TRUE,
                     verification_token = NULL,
                     verification_expires = NULL
                 WHERE id = ?`,

                [user.id]
            );


            // --------------------------------------------------
            // SUCCESS PAGE
            // --------------------------------------------------

            return res.send(`

                <!DOCTYPE html>

                <html>

                <head>

                    <meta charset="UTF-8">

                    <meta
                        name="viewport"
                        content="width=device-width, initial-scale=1.0"
                    >

                    <title>
                        Email Verified - Bid My Car
                    </title>

                </head>


                <body style="
                    font-family:Arial,sans-serif;
                    background:#061827;
                    color:white;
                    text-align:center;
                    padding:60px 20px;
                ">


                    <h1 style="
                        color:#39A7FF;
                    ">

                        Email Verified Successfully!

                    </h1>


                    <p>
                        Your Bid My Car account has been verified.
                    </p>


                    <p>
                        You can now return to Bid My Car and log in.
                    </p>


                </body>

                </html>

            `);

        } catch (error) {

            console.error(
                "Email verification error:",
                error
            );

            return res.status(500).send(
                "Email verification failed."
            );
        }
    }
);


// ======================================================
// GET CURRENT USER
// GET /api/auth/me
// ======================================================

router.get(
    "/me",
    authenticateToken,
    async (req, res) => {

        try {

            const [users] = await db.query(

                `SELECT
                    id,
                    name,
                    email,
                    role
                 FROM users
                 WHERE id = ?`,

                [req.user.userId]
            );


            if (users.length === 0) {

                return res.status(404).json({
                    success: false,
                    message:
                        "User not found"
                });
            }


            const user = users[0];


            // --------------------------------------------------
            // IMPORTANT PRIVACY RULE
            //
            // Phone is deliberately NOT returned here.
            // --------------------------------------------------

            return res.status(200).json({

                success: true,

                user: {

                    id: user.id,

                    name: user.name,

                    email: user.email,

                    role: user.role

                }

            });

        } catch (error) {

            console.error(
                "Get user error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Failed to get user information"
            });
        }
    }
);

// ======================================================
// EDIT PROFILE
// PUT /api/auth/profile
// ======================================================

router.put(
    "/profile",
    authenticateToken,
    async (req, res) => {

        try {

            const {
                name,
                phone
            } = req.body;

            // --------------------------------------------------
            // VALIDATE NAME
            // --------------------------------------------------

            if (!name || name.trim().length < 2) {

                return res.status(400).json({
                    success: false,
                    message: "Please enter a valid name"
                });
            }

            const cleanName = name.trim();

            // --------------------------------------------------
            // VALIDATE PHONE
            // --------------------------------------------------

            const cleanPhone = normalizePhone(phone);

            if (!cleanPhone) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please enter a valid Indian mobile number"
                });
            }

            // --------------------------------------------------
            // UPDATE USER
            // --------------------------------------------------

            await db.query(
                `UPDATE users
                 SET name = ?,
                     phone = ?
                 WHERE id = ?`,
                [
                    cleanName,
                    cleanPhone,
                    req.user.userId
                ]
            );

            // --------------------------------------------------
            // GET UPDATED USER
            // --------------------------------------------------

            const [users] = await db.query(
                `SELECT
                    id,
                    name,
                    email,
                    phone,
                    role,
                    wallet_balance
                 FROM users
                 WHERE id = ?`,
                [req.user.userId]
            );

            if (users.length === 0) {

                return res.status(404).json({
                    success: false,
                    message: "User not found"
                });
            }

            return res.status(200).json({

                success: true,

                message: "Profile updated successfully",

                user: users[0]

            });

        } catch (error) {

            console.error(
                "Edit profile error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Failed to update profile"
            });
        }
    }
);



// ======================================================
// GET WALLET
// GET /api/auth/wallet
// ======================================================

router.get(
    "/wallet",
    authenticateToken,
    async (req, res) => {

        try {

            // --------------------------------------------------
            // GET WALLET BALANCE
            // --------------------------------------------------

            const [users] = await db.query(
                `SELECT
                    id,
                    wallet_balance
                 FROM users
                 WHERE id = ?`,
                [req.user.userId]
            );

            if (users.length === 0) {

                return res.status(404).json({
                    success: false,
                    message: "User not found"
                });
            }

            // --------------------------------------------------
            // GET TRANSACTIONS
            // --------------------------------------------------

            const [transactions] = await db.query(
                `SELECT
                    id,
                    type,
                    amount,
                    description,
                    reference_id,
                    created_at
                 FROM wallet_transactions
                 WHERE user_id = ?
                 ORDER BY created_at DESC`,
                [req.user.userId]
            );

            return res.status(200).json({

                success: true,

                wallet: {

                    balance:
                        Number(users[0].wallet_balance),

                    transactions:
                        transactions.map(transaction => ({
                            id: transaction.id,
                            type: transaction.type,
                            amount: Number(transaction.amount),
                            description: transaction.description,
                            referenceId: transaction.reference_id,
                            createdAt: transaction.created_at
                        }))

                }

            });

        } catch (error) {

            console.error(
                "Get wallet error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Failed to get wallet information"
            });
        }
    }
);



// ======================================================
// ADD MONEY TO WALLET
// POST /api/auth/wallet/add
// ======================================================

router.post(
    "/wallet/add",
    authenticateToken,
    async (req, res) => {

        const connection =
            await db.getConnection();

        try {

            const {
                amount,
                description
            } = req.body;

            // --------------------------------------------------
            // VALIDATE AMOUNT
            // --------------------------------------------------

            const walletAmount =
                Number(amount);

            if (
                !Number.isFinite(walletAmount) ||
                walletAmount <= 0
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please enter a valid amount"
                });
            }

            if (walletAmount > 1000000) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Maximum wallet addition is ₹10,00,000"
                });
            }

            // --------------------------------------------------
            // START TRANSACTION
            // --------------------------------------------------

            await connection.beginTransaction();

            // --------------------------------------------------
            // UPDATE BALANCE
            // --------------------------------------------------

            await connection.query(
                `UPDATE users
                 SET wallet_balance =
                     wallet_balance + ?
                 WHERE id = ?`,
                [
                    walletAmount,
                    req.user.userId
                ]
            );

            // --------------------------------------------------
            // CREATE TRANSACTION RECORD
            // --------------------------------------------------

            const referenceId =
                `WALLET-${crypto.randomBytes(8).toString("hex")}`;

            await connection.query(
                `INSERT INTO wallet_transactions
                (
                    user_id,
                    type,
                    amount,
                    description,
                    reference_id
                )
                VALUES (?, 'credit', ?, ?, ?)`,
                [
                    req.user.userId,
                    walletAmount,
                    description ||
                        "Money added to wallet",
                    referenceId
                ]
            );

            await connection.commit();

            // --------------------------------------------------
            // GET NEW BALANCE
            // --------------------------------------------------

            const [users] = await db.query(
                `SELECT wallet_balance
                 FROM users
                 WHERE id = ?`,
                [req.user.userId]
            );

            return res.status(200).json({

                success: true,

                message:
                    "Money added to wallet successfully",

                wallet: {

                    balance:
                        Number(users[0].wallet_balance),

                    transaction: {

                        type: "credit",

                        amount: walletAmount,

                        referenceId

                    }

                }

            });

        } catch (error) {

            await connection.rollback();

            console.error(
                "Add wallet money error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Failed to add money to wallet"
            });

        } finally {

            connection.release();
        }
    }
);



// ======================================================
// WALLET FAQ
// GET /api/auth/faqs
// ======================================================

router.get(
    "/faqs",
    async (req, res) => {

        try {

            const faqs = [

                {
                    id: 1,
                    question:
                        "What is Bid My Car?",
                    answer:
                        "Bid My Car is a vehicle marketplace where users can browse vehicles and participate in auctions."
                },

                {
                    id: 2,
                    question:
                        "How does bidding work?",
                    answer:
                        "Users can place bids on available vehicles during an active auction. The highest valid bid at the end of the auction wins."
                },

                {
                    id: 3,
                    question:
                        "What is the Bid My Car wallet?",
                    answer:
                        "The wallet stores your available balance that can be used for supported transactions on the platform."
                },

                {
                    id: 4,
                    question:
                        "How can I add money to my wallet?",
                    answer:
                        "Open your profile, go to Wallet and use the Add Money option."
                },

                {
                    id: 5,
                    question:
                        "Can I edit my profile?",
                    answer:
                        "Yes. You can update your name and mobile number from the Edit Profile section."
                },

                {
                    id: 6,
                    question:
                        "How do I reset my password?",
                    answer:
                        "Use the Forgot Password option on the login page. A password reset link will be sent to your registered email address."
                },

                {
                    id: 7,
                    question:
                        "Why do I need to verify my email?",
                    answer:
                        "Email verification helps confirm ownership of your registered email address before you can log in."
                },

                {
                    id: 8,
                    question:
                        "Can I see my wallet transactions?",
                    answer:
                        "Yes. Your wallet section displays your credit and debit transaction history."
                }

            ];

            return res.status(200).json({

                success: true,

                faqs

            });

        } catch (error) {

            console.error(
                "FAQ error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Failed to load FAQs"
            });
        }
    }
);
// ======================================================
// EXPORT ROUTER
// ======================================================
module.exports = router;