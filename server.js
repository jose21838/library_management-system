const express = require('express');
const path = require('path');
const hbs = require('hbs');
const bcrypt = require('bcrypt'); 
const moment = require('moment');
const mysql = require('mysql2/promise');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const dotenv = require('dotenv');
const { fileURLToPath } = require('url');
const session = require('express-session');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const MySQLStore = require('express-mysql-session')(session);
const PDFLib = require('pdf-lib'); // Renamed to avoid conflict
const puppeteer = require('puppeteer');

// fs is already imported above, so removed the duplicate import

dotenv.config({ path: './.env' });

const app = express();
const PORT = 3000;
// Database Connection
const db = mysql.createPool({
    host: process.env.DATABASE_HOST,
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Session Store
const sessionStore = new MySQLStore({}, db);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Middleware to log requests
app.use((req, res, next) => {
    console.log(`Incoming Request: ${req.method} ${req.url}`);
    next();
});

app.use(session({
    secret: 'library_secret',
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
        secure: false, // true in production with HTTPS
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

app.use(express.static(path.join(__dirname, 'public')));

// Set Handlebars
app.set("views", path.join(__dirname, "views"));
app.set('view engine', 'hbs');

// Register Handlebars helpers - CORRECTED VERSION
hbs.registerHelper("eq", function (v1, v2, options) {
    if (v1 === v2) {
        return options.fn(this);
    }
    return options.inverse(this);
});

// Also register a subexpression version for use with {{#if (eq_check v1 v2)}}
hbs.registerHelper("eq_check", function (v1, v2) {
    return v1 === v2;
});

// 🏠 Home
app.get("/", (req, res) => res.render('homepage'));

// 🔑 Admin Login
app.get("/adminLogin", (req, res) => res.render('adminLogin'));

app.post("/adminLogin", async (req, res) => {
    const { email, password } = req.body;
    try {
        // Update the column name in the SQL query from UserId to user_id
        const [results] = await db.execute(
            "SELECT user_id, passwordHash FROM users WHERE LOWER(email) = LOWER(?) AND role = 'Admin'",
            [email]
        );

        if (results.length === 0) return res.send("Invalid email or password.");

        const admin = results[0];
        const passwordMatch = await bcrypt.compare(password, admin.passwordHash);
        if (!passwordMatch) return res.send("Invalid email or password.");

        // Update the reference to admin.UserId to admin.user_id
        req.session.adminId = admin.user_id;
        req.session.save(() => res.redirect("/adminDashboard"));
    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).send("Database error.");
    }
});

// Logout
app.get("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/adminLogin"));
});

//  Admin Dashboard
app.get("/adminDashboard", async (req, res) => {
    if (!req.session.adminId) return res.redirect("/adminLogin");

    try {
        const [pendingUsers] = await db.execute("SELECT * FROM users WHERE status = 'pending'");
        res.render("adminDashboard", { pendingUsers });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database error.");
    }
});
// Booking Management
// Booking Management
// Fetch bookings for management
app.get('/manageBookings', async (req, res) => {
    if (!req.session.adminId) {
        return res.redirect("/adminLogin");
    }

    try {
        // Fetch bookings with book details and user information
        const [bookings] = await db.execute(`
            SELECT 
                bookings.booking_id, 
                users.username, 
                users.email, 
                books.title AS book_title, 
                DATE_FORMAT(bookings.booking_date, '%Y-%m-%d') AS booking_date, 
                bookings.quantity,
                bookings.expected_return_date,
                bookings.actual_return_date,
                bookings.status 
            FROM bookings 
            JOIN users ON bookings.User_id = users.user_id
            JOIN books ON bookings.Book_id = books.book_id
        `);
                  // Add the 'isPending' flag to each booking
        bookings.forEach(booking => {
            booking.isPending = booking.status === 'Pending';
        });
        // Render the manageBookings page with the fetched bookings
        res.render('manageBookings', { bookings });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error fetching bookings");
    }
});

// ✅ Approve a booking
app.post('/manageBookings/approve/:booking_id', async (req, res) => {
    if (!req.session.adminId) {
        return res.redirect("/adminLogin");
    }

    try {
        const bookingId = req.params.booking_id;

        // Check if the booking exists
        const [bookingDetails] = await db.execute(
            "SELECT booking_date FROM bookings WHERE booking_id = ?",
            [bookingId]
        );

        if (bookingDetails.length === 0) {
            return res.status(404).send("Booking not found.");
        }

        // ✅ No need to calculate or update expected_return_date if it's a generated column
        await db.execute(
            "UPDATE bookings SET status = 'Approved' WHERE booking_id = ?",
            [bookingId]
        );

        res.redirect('/manageBookings');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error updating booking");
    }
});



// ❌ Reject a booking
app.post('/manageBookings/reject/:booking_id', async (req, res) => {
    if (!req.session.adminId) {
        return res.redirect("/adminLogin");
    }

    try {
        const bookingId = req.params.booking_id;

        // Update the status of the booking to "Rejected"
        await db.execute('UPDATE bookings SET status = "Rejected" WHERE booking_id = ?', [bookingId]);
        res.redirect('/manageBookings');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error updating booking");
    }
});
// Reservations Management

// Display all reservations
app.get('/managereservations', async (req, res) => {
    try {
        const [results] = await db.query(`
            SELECT 
                reservation_id,
                username,
                resources.resource_name,
                reservation_date,
                Duration as duration,
                reservations.Status as status
            FROM reservations
            JOIN resources ON reservations.Resource_id = resources.resource_id
            JOIN users ON reservations.User_id = users.user_id
        `);
        
        // Add isPending property to each reservation
        const reservationsWithPending = results.map(reservation => ({
            ...reservation,
            isPending: reservation.status === 'pending'
        }));
        
        res.render('managereservations', { reservations: reservationsWithPending });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database error.");
    }
});
// Approve reservation via POST (to match the form method in the HBS template)
app.post('/managereservations/approve/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.query("UPDATE reservations SET Status = 'approved' WHERE Reservation_id = ?", [id]);
        res.redirect('/managereservations');
    } catch (err) {
        console.error(err);
        res.status(500).send("Database error.");
    }
});

// Reject reservation via POST (to match the form method in the HBS template)
app.post('/managereservations/reject/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.query("UPDATE reservations SET Status = 'rejected' WHERE Reservation_id = ?", [id]);
        res.redirect('/managereservations');
    } catch (err) {
        console.error(err);
        res.status(500).send("Database error.");
    }
});
// Admin Profile
app.get("/adminProfile", async (req, res) => {
    if (!req.session.adminId) {
        return res.redirect("/adminLogin");
    }

    try {
        const [adminDetails] = await db.execute(
            "SELECT username, phoneNumber, email, role FROM users WHERE User_id = ?",
            [req.session.adminId]
        );

        if (adminDetails.length === 0) {
            return res.status(404).send("Admin not found.");
        }

        res.render("adminProfile", { admin: adminDetails[0] });
    } catch (err) {
        console.error("Error fetching admin profile:", err);
        res.status(500).send("Database error.");
    }
});

// Resource Management and bookmanagement Page
app.get("/resourceManagement", async (req, res) => {
try {
    const [resources] = await db.execute("SELECT * FROM resources");
    const [books] = await db.execute("SELECT * FROM books");
    res.render("resourceManagement", { resources, books });
} catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).send("Server error");
}
});

// API: Add a Book
app.post("/api/books", async (req, res) => {
try {
    const { title, category, available_copies } = req.body;
    await db.execute(
    "INSERT INTO books (title, category, available_copies) VALUES (?, ?, ?)",
    [title, category, available_copies]
    );
    res.json({ message: "Book added successfully!" });
} catch (err) {
    res.status(500).json({ error: err.message });
}
});

// API: Delete a Book
app.delete("/api/books/:id", async (req, res) => {
try {
    await db.execute("DELETE FROM books WHERE book_id = ?", [req.params.id]);
    res.json({ message: "Book deleted successfully!" });
} catch (err) {
    res.status(500).json({ error: err.message });
}
});

// API: Add a Resource
app.post("/api/resources", async (req, res) => {
try {
    const { resource_name, resource_type, quantity_available } = req.body;
    await db.execute(
    "INSERT INTO resources (resource_name, resource_type, quantity_available, added_at) VALUES (?, ?, ?, NOW())",
    [resource_name, resource_type, quantity_available]
    );
    res.json({ message: "Resource added successfully!" });
} catch (err) {
    res.status(500).json({ error: err.message });
}
});

// API: Delete a Resource
app.delete("/api/resources/:id", async (req, res) => {
try {
    await db.execute("DELETE FROM resources WHERE resource_id = ?", [req.params.id]);
    res.json({ message: "Resource deleted successfully!" });
} catch (err) {
    res.status(500).json({ error: err.message });
}
});

// User Management Route
app.get("/userManagement", async (req, res) => {
    try {
        // Fetch all registered users
        const [users] = await db.execute("SELECT username, fullname, email, phoneNumber, role FROM users");

        // Fetch pending users
        const [pendingUsers] = await db.execute("SELECT username, fullname, email, phoneNumber FROM users WHERE status = 'pending'");

        // Fetch approved users
        const [approvedUsers] = await db.execute("SELECT username, fullname, email, phoneNumber FROM users WHERE status = 'approved'");

        res.render("userManagement", { users, pendingUsers, approvedUsers });
    } catch (error) {
        console.error("Database error:", error);
        res.status(500).send("Error retrieving users.");
    }
});

// Approve a Pending User (Fixed Version with Transactions)
app.post("/approveUser/:user_id", async (req, res) => {
    const { user_id } = req.params;
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // Fetch user details from pending users
        const [user] = await connection.execute("SELECT * FROM users WHERE user_id = ? AND status = 'pending'", [user_id]);

        if (user.length === 0) {
            await connection.rollback();
            return res.status(404).send("User not found in pending users.");
        }

        // Generate a default hashed password
        const hashedPassword = await bcrypt.hash('DefaultPass123', 10);

        // Approve user by updating status
        await connection.execute(
            "UPDATE users SET status = 'approved', PasswordHash = ? WHERE user_id = ?",
            [hashedPassword, user_id]
        );

        await connection.commit();
        res.redirect("/userManagement");
    } catch (error) {
        await connection.rollback();
        console.error("Error approving user:", error);
        res.status(500).send("Failed to approve user.");
    } finally {
        connection.release();
    }
});

// Reject a Pending User
app.post("/rejectUser/:user_id", async (req, res) => {
    const { user_id } = req.params;

    try {
        // Delete user from pending users safely
        const [result] = await db.execute(
            "DELETE FROM users WHERE user_id = ? AND status = 'pending'",
            [user_id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).send("User not found.");
        }

        res.redirect("/userManagement");
    } catch (error) {
        console.error("Error rejecting user:", error);
        res.status(500).send("Failed to reject user.");
    }
});

// Reset Password - Modified to work with username instead of user_id
app.post("/resetPassword/:username", async (req, res) => {
    const { username } = req.params;

    try {
        // First, get the user by username
        const [user] = await db.execute("SELECT user_id FROM users WHERE username = ?", [username]);
        
        if (user.length === 0) {
            return res.status(404).send("User not found.");
        }
        
        const userId = user[0].user_id;
        
        // Generate a new default password
        const defaultPassword = 'ResetPass123';
        const hashedPassword = await bcrypt.hash(defaultPassword, 10);

        // Update the user's password using the retrieved user_id
        const [result] = await db.execute(
            "UPDATE users SET PasswordHash = ? WHERE user_id = ?",
            [hashedPassword, userId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).send("Failed to update password.");
        }

        // In a real application, you might want to email the new password to the user
        res.redirect("/userManagement");
    } catch (error) {
        console.error("Error resetting password:", error);
        res.status(500).send("Failed to reset password.");
    }
});

// Keep the resetPasswordByForm route for form submissions
app.post("/resetPasswordByForm", async (req, res) => {
    const { user_id } = req.body;

    try {
        // Generate a new default password
        const defaultPassword = 'ResetPass123';
        const hashedPassword = await bcrypt.hash(defaultPassword, 10);

        // Update the user's password
        const [result] = await db.execute(
            "UPDATE users SET PasswordHash = ? WHERE user_id = ?",
            [hashedPassword, user_id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).send("User not found.");
        }

        res.redirect("/userManagement");
    } catch (error) {
        console.error("Error resetting password:", error);
        res.status(500).send("Failed to reset password.");
    }
});
// Delete User - FIXED to remove book borrowing checks
app.post("/deleteUser/:username", async (req, res) => {
    const { username } = req.params;

    try {
        // Get the user's ID first
        const [user] = await db.execute(
            "SELECT user_id FROM users WHERE username = ?",
            [username]
        );

        if (user.length === 0) {
            return res.status(404).send("User not found.");
        }

        const userId = user[0].user_id;

        // Check if user has any pending fines
        const [fines] = await db.execute(
            "SELECT * FROM fines WHERE user_id = ?",
            [userId]
        );

        if (fines.length > 0) {
            return res.status(400).send("User has pending fines. Cannot delete.");
        }

        // Delete the user (removed borrowed books check)
        await db.execute(
            "DELETE FROM users WHERE user_id = ?",
            [userId]
        );

        res.redirect("/userManagement");
    } catch (error) {
        console.error("Error deleting user:", error);
        res.status(500).send("Failed to delete user.");
    }
});

// Add New User
app.post("/addUser", async (req, res) => {
    const { username, fullname, email, phoneNumber, password, role } = req.body;

    try {
        // Hash the password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert the new user with fullname and phoneNumber
        await db.execute(
            "INSERT INTO users (username, fullname, email, phoneNumber, PasswordHash, role, status) VALUES (?, ?, ?, ?, ?, ?, 'approved')",
            [username, fullname, email, phoneNumber, hashedPassword, role]
        );

        res.redirect("/userManagement");
    } catch (error) {
        console.error("Error adding user:", error);
        res.status(500).send("Failed to add user.");
    }
});

// Reset Password by Form (new route for form submissions)
app.post("/resetPasswordByForm", async (req, res) => {
    const { user_id } = req.body;

    try {
        // Generate a new default password
        const defaultPassword = 'ResetPass123';
        const hashedPassword = await bcrypt.hash(defaultPassword, 10);

        // Update the user's password
        const [result] = await db.execute(
            "UPDATE users SET PasswordHash = ? WHERE user_id = ?",
            [hashedPassword, user_id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).send("User not found.");
        }

        res.redirect("/userManagement");
    } catch (error) {
        console.error("Error resetting password:", error);
        res.status(500).send("Failed to reset password.");
    }
});

// Fetch Pending Users Page
app.get("/pendingUsers", async (req, res) => {
    try {
        // Fetch users with pending status
        const [pendingUsers] = await db.execute(
            "SELECT user_id, username, fullname, email, phoneNumber FROM users WHERE status = 'pending'"
        );

        res.render("pendingUsers", { pendingUsers });
    } catch (error) {
        console.error("Error fetching pending users:", error);
        res.status(500).send("Failed to retrieve pending users.");
    }
});



// ✅ Middleware to check if admin is logged in
function checkAdmin(req, res, next) {
    if (!req.session || !req.session.adminId) {
        return res.redirect("/adminLogin");
    }
    next();
}

// ✅ GET Route to Fetch Pending, Approved, and Rejected Payments
app.get("/paymentManagement", checkAdmin, async (req, res) => {
    try {
        const [payments] = await db.execute(`
            SELECT 
                payments.payment_id, 
                payments.transaction_id, 
                payments.user_id, 
                users.username, 
                users.email, 
                payments.amount, 
                payments.reason, 
                payments.status, 
                DATE_FORMAT(payments.time_of_payment, '%Y-%m-%d %H:%i:%s') AS time_of_payment,
                DATE_FORMAT(payments.time_of_verification, '%Y-%m-%d %H:%i:%s') AS time_of_verification
            FROM payments 
            JOIN users ON payments.user_id = users.user_id
            WHERE payments.status IN ('Pending', 'Approved', 'Rejected')
        `);

        console.log("Payments Data:", payments); // Debugging
        res.render("paymentManagement", { payments: payments || [] });
    } catch (err) {
        console.error("Error fetching payments:", err);
        res.status(500).send("Error retrieving payments.");
    }
});

// ✅ POST Route to Approve a Payment
app.post("/managePayments/approve/:payment_id", checkAdmin, async (req, res) => {
    try {
        const payment_id = req.params.payment_id;

        // Update the payment status
        await db.execute(
            "UPDATE payments SET status = 'Approved', time_of_verification = NOW() WHERE payment_id = ?",
            [payment_id]
        );

        // Insert action into payment_actions table
        await db.execute(
            "INSERT INTO payment_actions (payment_id, action, action_time) VALUES (?, 'Approved', NOW())",
            [payment_id]
        );

        res.redirect("/paymentManagement");
    } catch (err) {
        console.error("Error approving payment:", err);
        res.status(500).send("Error approving payment.");
    }
});

// ✅ POST Route to Reject a Payment
app.post("/managePayments/reject/:payment_id", checkAdmin, async (req, res) => {
    try {
        const payment_id = req.params.payment_id;

        // Update the payment status
        await db.execute(
            "UPDATE payments SET status = 'Rejected', time_of_verification = NOW() WHERE payment_id = ?",
            [payment_id]
        );

        // Insert action into payment_actions table
        await db.execute(
            "INSERT INTO payment_actions (payment_id, action, action_time) VALUES (?, 'Rejected', NOW())",
            [payment_id]
        );

        res.redirect("/paymentManagement");
    } catch (err) {
        console.error("Error rejecting payment:", err);
        res.status(500).send("Error rejecting payment.");
    }
});

/// GET Route to View Feedback Management Page
app.get('/feedbackManagement', checkAdmin, async (req, res) => {
    try {
        const query = `
            SELECT 
                Feedback_id, 
                User_id, 
                Username, 
                Comment, 
                Posted_at 
            FROM feedback
            ORDER BY Posted_at DESC
        `;
        
        const [feedback] = await db.query(query);
        console.log("Fetched Feedbacks:", feedback); // Debugging
        res.render('feedbackManagement', { feedback });
    } catch (error) {
        console.error(error);
        res.status(500).send("Error retrieving feedback");
    }
});

// POST Route to Mark Feedback as Reviewed
app.post('/markReviewed/:id', checkAdmin, async (req, res) => {
    try {
        const feedbackId = req.params.id;
        const adminId = req.session.adminId; // Admin ID from session

        // Insert a record of the action (marking as reviewed)
        const query = `
            INSERT INTO feedback_actions (Feedback_id, adminID, action, action_time) 
            VALUES (?, ?, 'Reviewed', NOW())
            ON DUPLICATE KEY UPDATE action = 'Reviewed', action_time = NOW();
        `;

        await db.query(query, [feedbackId, adminId]);
        res.redirect('/feedbackManagement');
    } catch (error) {
        console.error(error);
        res.status(500).send("Error updating feedback status");
    }
});

// Route for reports and analytics page
app.get('/admin/reports_analytics', (req, res) => {
    res.render('reports_analytics'); // This will render 'reports_analytics.hbs' from the 'views' directory
});
// Main routes
// Admin Dashboard Route (GET)
app.get('/admin/dashboard', (req, res) => {
    if (!req.session.adminId) {
        return res.redirect('/admin/login'); // Redirect to login if not authenticated
    }

    res.render('dashboard', {
        pageTitle: 'Admin Dashboard',
        adminId: req.session.adminId
    });
});

app.get('/manage_bookings', (req, res) => {
    res.render('manage_bookings');
});

app.get('/manage_resources', (req, res) => {
    res.render('manage_resources');
});

app.get('/user_management', (req, res) => {
    res.render('user_management');
});

app.get('/reports_analytics', (req, res) => {
    res.render('reports_analytics');
});

// Route to handle logout
app.get('/admin/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error("Logout error:", err);
            return res.status(500).send('Logout failed');
        }
        res.redirect('/admin/login'); // Redirect admin to login page after logout
    });
});
// Route to fetch all books
app.get('/api/books-report', async(req, res) => {
    try {
        const [books] = await db.query(`
            SELECT Book_id, Title, category, available_copies
            FROM books
        `);

        let total = books.length;
        let available = 0;
        let borrowed = 0;
        const bookTitles = [];
        const bookQuantities = [];

        books.forEach(book => {
            const availableCount = book.available_copies || 0;
            available += availableCount;
            bookTitles.push(book.Title);
            bookQuantities.push(availableCount);
        });

        // Assuming borrowed = total copies (not provided) - available_copies
        // If there's no "total_copies" column, we can't calculate borrowed count accurately
        // We'll just return available for now
        res.json({
            available,
            borrowed: '-', // Cannot calculate without total_copies
            popular: '-', // Still not tracked
            list: books,
            chartLabels: bookTitles,
            chartData: bookQuantities
        });
    } catch (error) {
        console.error('Error in /api/books-report:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// download books report as PDF
app.get('/reports_analytics/download/books', async(req, res) => {
    try {
        const [books] = await db.query(`
            SELECT Book_id, Title, category, available_copies
            FROM books
        `);

        const doc = new PDFDocument({ margin: 40, size: 'A4' });

        const filePath = path.join(__dirname, 'books_report.pdf');
        const writeStream = fs.createWriteStream(filePath);
        doc.pipe(writeStream);

        // Header
        doc.fontSize(22).fillColor('#2E86C1').text('Library Books Report', { align: 'center' });
        doc.moveDown();

        // Table layout
        const tableTop = 100;
        const rowHeight = 25;

        // Table header
        doc.rect(40, tableTop, 500, rowHeight).fill('#D6EAF8');
        doc.fillColor('#000').font('Helvetica-Bold').fontSize(10);
        doc.text('ID', 45, tableTop + 7);
        doc.text('Title', 90, tableTop + 7);
        doc.text('Category', 300, tableTop + 7);
        doc.text('Available', 430, tableTop + 7);

        let y = tableTop + rowHeight;
        doc.font('Helvetica').fontSize(10);

        books.forEach(book => {
            if (y > 750) {
                doc.addPage();
                y = 50;
            }

            doc.rect(40, y, 500, rowHeight).stroke();
            doc.text(book.Book_id.toString(), 45, y + 7);
            doc.text(book.Title, 90, y + 7, { width: 200, ellipsis: true });
            doc.text(book.category || 'N/A', 300, y + 7);
            doc.text(book.available_copies.toString(), 430, y + 7);

            y += rowHeight;
        });

        doc.end();

        writeStream.on('finish', () => {
            res.download(filePath, 'books_report.pdf', err => {
                if (err) console.error('Download error:', err);
                fs.unlink(filePath, () => {}); // Clean up temp file
            });
        });
    } catch (err) {
        console.error('Error generating PDF:', err);
        res.status(500).send('Error generating PDF');
    }
});

// Route to fetch all users
app.get('/admin/users', async(req, res) => {
    try {
        const [users] = await db.query(`
        SELECT user_id, username, fullname, email, phoneNumber, role
        FROM users
    `);
        res.json(users); // Return the list of users as JSON
    } catch (err) {
        console.error('Error fetching users:', err);
        res.status(500).send('Error fetching users');
    }
});
// Route to fetch user statistics
app.get('/admin/users-stats', async(req, res) => {
    try {
        const [results] = await pool.query(`
        SELECT role, COUNT(*) as count
        FROM users
        GROUP BY role
`);
        res.json(results);
    } catch (error) {
        console.error('Error fetching user stats:', error);
        res.status(500).send('Error fetching user stats');
    }
});

// Users PDF Download Route
app.get('/reports_analytics/download/users', async(req, res) => {
    try {
        const [users] = await pool.query(`
        SELECT user_id, username, fullname, email, phoneNumber, role
        FROM users
`);

        const doc = new PDFDocument({ margin: 40, size: 'A4' });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="user_report.pdf"');

        doc.pipe(res);

        // Title
        doc.fontSize(18).fillColor('#333').font('Helvetica-Bold').text('User Report', { align: 'center' });
        doc.moveDown(1);

        // Table setup
        const tableTop = doc.y;
        const rowHeight = 25;
        const colX = [40, 80, 170, 290, 430, 510];
        const colWidths = [40, 90, 120, 140, 80, 60];

        const drawHeader = (y) => {
            doc.rect(colX[0] - 5, y - 2, 540, rowHeight).fill('#eeeeee'); // header bg

            const headers = ['ID', 'Username', 'Full Name', 'Email', 'Phone', 'Role'];
            headers.forEach((header, i) => {
                doc
                    .fillColor('#000')
                    .font('Helvetica-Bold')
                    .fontSize(11)
                    .text(header, colX[i], y + 6, { width: colWidths[i], align: 'left' });
            });

            doc.fillColor('#000'); // reset color
        };

        const drawRow = (y, user) => {
            const values = [
                user.user_id,
                user.username,
                user.fullname,
                user.email,
                user.phoneNumber,
                user.role,
            ];

            // Draw cell borders
            for (let i = 0; i < colX.length; i++) {
                doc
                    .strokeColor('#cccccc')
                    .lineWidth(0.5)
                    .rect(colX[i] - 5, y - 2, colWidths[i], rowHeight)
                    .stroke();
            }

            // Fill values
            values.forEach((val, i) => {
                doc
                    .font('Helvetica')
                    .fontSize(10)
                    .fillColor('#000')
                    .text(String(val), colX[i], y + 6, { width: colWidths[i], align: 'left' });
            });
        };

        // Draw header
        drawHeader(tableTop);

        // Draw rows
        let y = tableTop + rowHeight;
        users.forEach(user => {
            if (y > 750) {
                doc.addPage();
                y = 40;
                drawHeader(y);
                y += rowHeight;
            }
            drawRow(y, user);
            y += rowHeight;
        });

        doc.end();
    } catch (err) {
        console.error('Error generating PDF:', err);
        res.status(500).send('Error generating PDF');
    }
});
// ✅ Transaction Report API
app.get('/api/transaction-report', async(req, res) => {
    try {
        const [rows] = await db.query(`
        SELECT transaction_id, username, email, reason, amount, status, time_of_payment
        FROM payments
        ORDER BY time_of_payment DESC
`);

        // Chart data
        const statusCounts = rows.reduce((acc, tx) => {
            acc[tx.status] = (acc[tx.status] || 0) + 1;
            return acc;
        }, {});

        res.json({
            list: rows,
            chartLabels: Object.keys(statusCounts),
            chartData: Object.values(statusCounts),
        });
    } catch (err) {
        console.error('💥 Error:', err);
        res.status(500).json({ error: 'Something went wrong'  });    
    }
});
// Route to generate chart data for transactions and display it in the frontend
app.get('/api/transactions-chart', async(req, res) => {
    try {
        const [rows] = await db.query(`
        SELECT transaction_id, username, email, reason, amount, status, time_of_payment
        FROM payments
        ORDER BY time_of_payment DESC
`);

        // Chart data
        const statusCounts = rows.reduce((acc, tx) => {
            acc[tx.status] = (acc[tx.status] || 0) + 1;
            return acc;
        }, {});

        res.json({
            chartLabels: Object.keys(statusCounts),
            chartData: Object.values(statusCounts),
        });
    } catch (err) {
        console.error('Error fetching transactions chart data:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});
// Transaction Report API: Download Transactions PDF
app.get('/reports_analytics/download/transactions', async(req, res) => {
    try {
        // Query to fetch transactions
        const [rows] = await db.query(`
        SELECT transaction_id, username, email, reason, amount, status, time_of_payment
        FROM payments
        ORDER BY time_of_payment DESC
    `);

        if (rows.length === 0) {
            return res.status(404).json({ error: 'No transactions found' });
        }

        const doc = new PDFDocument({ margin: 40, size: 'A4' });

        // Set headers for the response to send the PDF directly to the client
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="transaction_report.pdf"');

        doc.pipe(res); // Send the PDF to the client directly

        // Title
        doc.fontSize(18).fillColor('#333').font('Helvetica-Bold').text('Transaction Report', { align: 'center' });
        doc.moveDown(1);

        // Table setup
        const tableTop = doc.y;
        const rowHeight = 25;
        const colX = [40, 80, 170, 290, 430, 510, 590];
        const colWidths = [40, 90, 120, 140, 80, 60, 80];

        // Draw header row
        const drawHeader = (y) => {
            doc.rect(colX[0] - 5, y - 2, 540, rowHeight).fill('#eeeeee'); // header bg

            const headers = ['ID', 'Username', 'Email', 'Reason', 'Amount', 'Status', 'Date'];
            headers.forEach((header, i) => {
                doc
                    .fillColor('#000')
                    .font('Helvetica-Bold')
                    .fontSize(11)
                    .text(header, colX[i], y + 6, { width: colWidths[i], align: 'left' });
            });

            doc.fillColor('#000'); // reset color
        };

        // Draw individual data row
        const drawRow = (y, transaction) => {
            const values = [
                transaction.transaction_id,
                transaction.username,
                transaction.email,
                transaction.reason,
                transaction.amount,
                transaction.status,
                transaction.time_of_payment,
            ];

            // Draw cell borders
            for (let i = 0; i < colX.length; i++) {
                doc
                    .strokeColor('#cccccc')
                    .lineWidth(0.5)
                    .rect(colX[i] - 5, y - 2, colWidths[i], rowHeight)
                    .stroke();
            }

            // Fill cell values
            values.forEach((val, i) => {
                doc
                    .font('Helvetica')
                    .fontSize(10)
                    .fillColor('#000')
                    .text(String(val), colX[i], y + 6, { width: colWidths[i], align: 'left' });
            });
        };

        // Draw header
        drawHeader(tableTop);

        // Draw rows
        let y = tableTop + rowHeight;
        rows.forEach((transaction) => {
            if (y > 750) {
                doc.addPage();
                y = 40;
                drawHeader(y);
                y += rowHeight;
            }
            drawRow(y, transaction);
            y += rowHeight;
        });

        // Finish the document
        doc.end();
    } catch (err) {
        console.error('Error generating transaction PDF:', err);
        res.status(500).send('Error generating PDF');
    }
});
// Route to fetch all fines
app.get('/api/fine-report', async(req, res) => {
    try {
        // Fetch all fine records
        const [rows] = await db.query('SELECT * FROM fines');

        // Compute counts
        const pendingCount = rows.filter(r => r.status === 'Pending').length;
        const paidCount = rows.filter(r => r.status === 'Paid').length;

        // Compute total amounts
        const [amounts] = await db.execute(`
        SELECT 
        SUM(CASE WHEN status = 'Pending' THEN amount ELSE 0 END) AS pendingFines,
        SUM(CASE WHEN status = 'Paid' THEN amount ELSE 0 END) AS paidFines
        FROM fines
`);

        const pendingAmount = amounts[0].pendingFines || 0;
        const paidAmount = amounts[0].paidFines || 0;
        const totalFines = pendingAmount + paidAmount;

        res.json({
            list: rows, // full fine records
            chartLabels: ['Pending', 'Paid'],
            chartData: [pendingCount, paidCount], // for count chart
            pendingAmount,
            paidAmount,
            totalFines
        });
    } catch (error) {
        console.error('Error combining fine report:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
// Route to return fine report chart colors
app.get('/api/fine-report/colors', (req, res) => {
    const colors = {
        labels: ['Pending Fines', 'Paid Fines', 'Total Fines'],
        backgroundColors: ['#f6c23e', '#4e73df', '#1cc88a'] // Yellow, Blue, Green
    };
    res.json(colors);
});




// Route to download fines report as PDF
app.get('/reports_analytics/download/fines', async(req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT fine_id, user_id, description, amount, days_overdue
            FROM fines
            ORDER BY fine_id DESC
        `);

        if (rows.length === 0) {
            return res.status(404).json({ error: 'No fines found' });
        }

        const doc = new PDFDocument({ margin: 40, size: 'A4' });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="fines_report.pdf"');
        doc.pipe(res);

        // Title
        doc.fontSize(14).fillColor('#333').font('Helvetica-Bold').text('Fines Report', { align: 'center' });
        doc.moveDown(1);

        // Table setup
        const tableTop = doc.y;
        const rowHeight = 40;
        const colX = [40, 80, 170, 290, 430, 510, 590];
        const colWidths = [40, 90, 120, 140, 80, 60, 80];

        const drawHeader = (y) => {
            doc.rect(colX[0] - 5, y - 2, 540, rowHeight).fill('#eeeeee');

            const headers = ['ID', 'user_id', 'Description', 'Amount', 'Days_overdue', 'Date'];
            headers.forEach((header, i) => {
                doc
                    .fillColor('#000')
                    .font('Helvetica-Bold')
                    .fontSize(11)
                    .text(header, colX[i], y + 6, { width: colWidths[i], align: 'left' });
            });

            doc.fillColor('#000');
        };

        const drawRow = (y, fine) => {
            const values = [
                fine.fine_id,
                fine.email,
                fine.description,
                fine.amount,
                parseFloat(fine.amount).toFixed(2),

                fine.days_overdue,
            ];

            for (let i = 0; i < colX.length; i++) {
                doc
                    .strokeColor('#cccccc')
                    .lineWidth(0.5)
                    .rect(colX[i] - 5, y - 2, colWidths[i], rowHeight)
                    .stroke();
            }

            values.forEach((val, i) => {
                doc
                    .font('Helvetica')
                    .fontSize(10)
                    .fillColor('#000')
                    .text(String(val), colX[i], y + 6, { width: colWidths[i], align: 'left' });
            });
        };

        drawHeader(tableTop);

        let y = tableTop + rowHeight;
        rows.forEach((fine) => {
            if (y > 750) {
                doc.addPage();
                y = 40;
                drawHeader(y);
                y += rowHeight;
            }
            drawRow(y, fine);
            y += rowHeight;
        });

        doc.end();
    } catch (err) {
        console.error('Error exporting fines as PDF:', err);
        res.status(500).send('Error generating PDF');    
    }
});

// SESSION MIDDLEWARE - Place before any routes
app.use(session({
    key: 'library_session',
    secret: 'your-very-secure-secret-key', // Change this to a secure random string
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
        path: '/',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production', // Only use secure in production
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Register formatDate helper for Handlebars
// Improved formatDate helper with better error handling
hbs.registerHelper('formatDate', function(date, format) {
    try {
        // Check if date exists
        if (!date) {
            return '';
        }
        
        // Make sure format is a string
        if (!format || typeof format !== 'string') {
            format = 'YYYY-MM-DD'; // Default format
        }
        
        // Handle case where hbs passes options object as second parameter
        if (format.name === 'options' || format.hash) {
            format = 'YYYY-MM-DD';
        }
        
        // Format the date using moment.js with error handling
        const momentDate = moment(date);
        if (!momentDate.isValid()) {
            return 'Invalid date';
        }
        
        return momentDate.format(format);
    } catch (error) {
        console.error('Error in formatDate helper:', error);
        return 'Date error';
    }
});


// Authentication middleware - use for protected routes
const requireAuth = (req, res, next) => {
    if (!req.session.user) {
        return res.redirect('/userLogin');
    }
    next();
};

// USER SIGNUP
app.get('/userSignup', (req, res) => {
    res.render('userSignup');
});

app.post('/userSignup', async (req, res) => {
    try {
        const { fullname, email, phoneNumber, username, password } = req.body;

        // Check if username or email already exists
        const [checkResult] = await db.execute(
            'SELECT * FROM users WHERE username = ? OR email = ?', 
            [username, email]
        );

        if (checkResult.length > 0) {
            return res.render('userSignup', {
                error: 'Username or email already exists!'
            });
        }

        // Hash password
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // Insert new user into database
        await db.execute(`
            INSERT INTO users (username, fullname, email, phoneNumber, passwordHash, role, status, createdAt)
            VALUES (?, ?, ?, ?, ?, 'user', 'active', NOW())`,
            [username, fullname, email, phoneNumber, hashedPassword]
        );

        // Render success message
        res.render('userSignup', {
            success: true,
            message: 'Registration successful! You can now log in.'
        });

    } catch (error) {
        console.error('Error registering user:', error);
        res.render('userSignup', {
            error: 'Registration failed. Please try again.'
        });
    }
});

// USER LOGIN - GET route to display login form
app.get('/userLogin', (req, res) => {
    res.render('userLogin');
});

// USER LOGIN - POST route to handle form submission
app.post('/userLogin', async (req, res) => {
    try {
        const { username, password } = req.body;

        // Input validation
        if (!username || !password) {
            return res.render('userLogin', { 
                error: 'Please provide both username and password'
            });
        }

        // Check if user exists
        const [users] = await db.execute(
            'SELECT * FROM users WHERE username = ?', 
            [username]
        );

        if (users.length === 0) {
            return res.render('userLogin', { 
                error: 'Invalid username or password',
                username: username // Preserve username input
            });
        }

        const user = users[0];
        
        // Determine the correct field name for the password hash
        // Adjust according to your actual database column name
        const storedHash = user.passwordHash || user.PasswordHash || user.password_hash;
        
        // Ensure the hash exists before comparing
        if (!storedHash) {
            console.error(`Password hash not found in user record for username: ${username}`);
            return res.render('userLogin', { 
                error: 'Account configuration error. Please contact support.',
                username: username // Preserve username input
            });
        }

        // Compare passwords
        const isMatch = await bcrypt.compare(password, storedHash);
        
        if (!isMatch) {
            return res.render('userLogin', { 
                error: 'Invalid username or password',
                username: username // Preserve username input
            });
        }

        // Store user info in session
        req.session.user = {
            id: user.user_id || user.User_id, // Handle possible case variations
            username: user.username,
            role: user.role || 'user', // Default to 'user' if role is not set
            fullname: user.fullname || user.Fullname // For personalized greetings
        };

        // Log successful login
        console.log(`User ${username} logged in successfully`);

        // Redirect to dashboard
        res.redirect('/userDashboard');

    } catch (error) {
        console.error('Login error:', error);
        res.render('userLogin', { 
            error: 'Login failed. Please try again later.',
            username: req.body.username // Preserve username input
        });
    }
});

// Logout route
app.get('/userLogout', (req, res) => {
    // Get username before destroying session
    const username = req.session.user ? req.session.user.username : 'Unknown user';
    
    req.session.destroy(err => {
        if (err) {
            console.error(`Session destruction error for ${username}:`, err);
        } else {
            console.log(`User ${username} logged out successfully`);
        }
        res.redirect('/userLogin');
    });
});

// USER DASHBOARD - Protected route
app.get('/userDashboard', requireAuth, (req, res) => {
    res.render('userDashboard', { user: req.session.user });
});

// USER PROFILE - Protected route
app.get("/userProfile", requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        
        const [results] = await db.execute(
            "SELECT user_id, username, fullname, email, phoneNumber FROM users WHERE user_id = ?",
            [userId]
        );
        
        if (results.length > 0) {
            const userData = results[0];
            res.render('userProfile', {
                user: req.session.user,
                fullname: userData.fullname,
                username: userData.username,
                email: userData.email,
                phoneNumber: userData.phoneNumber
            });
        } else {
            res.status(404).render('error', { message: "User not found" });
        }
    } catch (error) {
        console.error("Database error:", error);
        res.status(500).render('error', { message: "Internal Server Error" });
    }
});

// LOGOUT
app.get('/userLogout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Session destruction error:', err);
        }
        res.redirect('/userLogin');
    });
});

// Route to directly borrow a book (with improved date handling and error checking)
app.post("/api/books/borrow", requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { book_id } = req.body;
        
        if (!book_id) {
            return res.status(400).json({ error: "Missing book_id" });
        }
        
        // Check if book is available
        const [bookResult] = await db.execute(
            "SELECT available_copies FROM books WHERE book_id = ?",
            [book_id]
        );
        
        if (bookResult.length === 0) {
            return res.status(404).json({ error: "Book not found" });
        }
        
        if (bookResult[0].available_copies <= 0) {
            return res.status(400).json({ error: "Book is not available for borrowing" });
        }
        
        // Set expected return date (default: 14 days from now)
        const returnDate = new Date();
        returnDate.setDate(returnDate.getDate() + 14); // 14 days borrowing period
        const formattedReturnDate = returnDate.toISOString().split('T')[0]; // Format as YYYY-MM-DD
        
        // Begin transaction
        await db.execute("START TRANSACTION");
        
        // Insert into bookings with all required fields
        const [insertResult] = await db.execute(
            `INSERT INTO bookings 
            (user_id, book_id, booking_date, status, expected_return_date) 
            VALUES (?, ?, NOW(), 'pending', ?)`,
            [userId, book_id, formattedReturnDate]
        );
        
        // Check if the insert was successful
        if (!insertResult || insertResult.affectedRows === 0) {
            await db.execute("ROLLBACK");
            console.error("Failed to insert into bookings table");
            return res.status(500).json({ error: "Failed to create booking record" });
        }
        
        // Update available copies in books table
        const [updateResult] = await db.execute(
            "UPDATE books SET available_copies = available_copies - 1 WHERE book_id = ?",
            [book_id]
        );
        
        if (!updateResult || updateResult.affectedRows === 0) {
            await db.execute("ROLLBACK");
            console.error("Failed to update book inventory");
            return res.status(500).json({ error: "Failed to update book inventory" });
        }
        
        // Commit transaction
        await db.execute("COMMIT");
        
        console.log(`Successfully created booking for user ${userId}, book ${book_id}`);
        
        res.json({ 
            message: "Borrowing request sent for approval. We will notify you upon successful approval",
            expected_return_date: formattedReturnDate,
            booking_id: insertResult.insertId
        });
    } catch (err) {
        // Rollback on error
        await db.execute("ROLLBACK");
        console.error("Database error:", err);
        res.status(500).json({ error: "Error processing borrow request", details: err.message });
    }
});


// Route to fetch books by category
app.get("/api/books/:category", requireAuth, async (req, res) => {
    try {
        console.log(`Fetching books for category: ${req.params.category}`);
        const category = req.params.category;
        
        const [results] = await db.execute(
            "SELECT book_id, title FROM books WHERE category = ?",
            [category]
        );
        
        console.log(`Found ${results.length} books in category ${category}`);
        res.json(results);
    } catch (err) {
        console.error("Database error when fetching books:", err);
        res.status(500).json({ error: "Internal Server Error", details: err.message });
    }
});

// Route to add books to cart (fixed duplicate implementation)
app.post("/api/cart/add", requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { book_id, quantity } = req.body;
        
        if (!book_id) {
            return res.status(400).json({ error: "Missing book_id" });
        }
        
        // Check if book already in cart
        const [existing] = await db.execute(
            "SELECT * FROM books_cart WHERE user_id = ? AND book_id = ?",
            [userId, book_id]
        );
        
        if (existing.length > 0) {
            // Update quantity if already in cart
            await db.execute(
                "UPDATE books_cart SET quantity = quantity + ? WHERE user_id = ? AND book_id = ?",
                [quantity || 1, userId, book_id]
            );
        } else {
            // Insert new cart item
            await db.execute(
                "INSERT INTO books_cart (user_id, book_id, quantity) VALUES (?, ?, ?)",
                [userId, book_id, quantity || 1]
            );
        }
        
        res.json({ message: "Book added to cart" });
    } catch (err) {
        console.error("Database error:", err);
        res.status(500).json({ error: "Error adding to cart" });
    }
});

// Route to fetch books from cart
app.get("/api/cart", requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        
        const [results] = await db.execute(`
            SELECT bc.cart_id, b.title, b.book_id, bc.quantity 
            FROM books_cart bc
            JOIN books b ON bc.book_id = b.book_id
            WHERE bc.user_id = ?
        `, [userId]);
        
        res.json(results);
    } catch (err) {
        console.error("Database error:", err);
        res.status(500).json({ error: "Error fetching cart" });
    }
});

// Route to checkout cart (with improved error handling and logging)
app.post("/api/cart/checkout", requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        
        // Fetch cart items first to check availability
        const [cartItems] = await db.execute(`
            SELECT bc.book_id, b.available_copies 
            FROM books_cart bc
            JOIN books b ON bc.book_id = b.book_id
            WHERE bc.user_id = ?
        `, [userId]);
        
        if (cartItems.length === 0) {
            return res.status(400).json({ error: "Cart is empty" });
        }
        
        console.log(`Processing checkout for user ${userId} with ${cartItems.length} items`);
        
        // Check if any book is unavailable
        const unavailableBooks = cartItems.filter(item => item.available_copies <= 0);
        if (unavailableBooks.length > 0) {
            return res.status(400).json({ 
                error: "Some books are not available for borrowing",
                unavailableBooks: unavailableBooks.map(item => item.book_id)
            });
        }
        
        // Set expected return date (default: 14 days from now)
        const returnDate = new Date();
        returnDate.setDate(returnDate.getDate() + 14); // 14 days borrowing period
        const formattedReturnDate = returnDate.toISOString().split('T')[0]; // Format as YYYY-MM-DD
        
        // Begin transaction
        await db.execute("START TRANSACTION");
        
        // Insert bookings with 'pending' status and expected return date - one by one for better error tracking
        const bookingResults = [];
        
        for (const item of cartItems) {
            const [insertResult] = await db.execute(
                `INSERT INTO bookings 
                (user_id, book_id, booking_date, status, expected_return_date)
                VALUES (?, ?, NOW(), 'pending', ?)`,
                [userId, item.book_id, formattedReturnDate]
            );
            
            if (!insertResult || insertResult.affectedRows === 0) {
                await db.execute("ROLLBACK");
                console.error(`Failed to insert booking for book ID ${item.book_id}`);
                return res.status(500).json({ error: "Failed to create booking records" });
            }
            
            bookingResults.push({
                book_id: item.book_id,
                booking_id: insertResult.insertId
            });
            
            // Update available copies for this book
            const [updateResult] = await db.execute(
                "UPDATE books SET available_copies = available_copies - 1 WHERE book_id = ?",
                [item.book_id]
            );
            
            if (!updateResult || updateResult.affectedRows === 0) {
                await db.execute("ROLLBACK");
                console.error(`Failed to update inventory for book ID ${item.book_id}`);
                return res.status(500).json({ error: "Failed to update book inventory" });
            }
        }
        
        // Clear cart
        const [deleteResult] = await db.execute("DELETE FROM books_cart WHERE user_id = ?", [userId]);
        
        if (!deleteResult) {
            await db.execute("ROLLBACK");
            console.error("Failed to clear cart");
            return res.status(500).json({ error: "Failed to clear cart" });
        }
        
        // Commit transaction
        await db.execute("COMMIT");
        
        console.log(`Successfully created ${bookingResults.length} bookings for user ${userId}`);
        
        res.json({ 
            message: "Booking request sent for approval. We will notify you upon successful approval",
            bookingsCreated: bookingResults.length,
            bookings: bookingResults,
            expected_return_date: formattedReturnDate
        });
    } catch (err) {
        // Rollback on error
        await db.execute("ROLLBACK");
        console.error("Database error:", err);
        res.status(500).json({ error: "Error processing checkout", details: err.message });
    }
});

// Route to remove book from cart
app.post("/api/cart/remove", requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { book_id } = req.body;
        
        if (!book_id) {
            return res.status(400).json({ error: "Missing book_id" });
        }
        
        const [result] = await db.execute(
            "DELETE FROM books_cart WHERE user_id = ? AND book_id = ?",
            [userId, book_id]
        );
        
        if (result.affectedRows > 0) {
            res.json({ message: "Book removed from cart successfully!" });
        } else {
            res.status(404).json({ error: "Book not found in cart" });
        }
    } catch (err) {
        console.error("Database error:", err);
        res.status(500).json({ error: "Error removing book from cart" });
    }
});
// Route to return books
app.post("/api/books/return", requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        
        // Check if we received an array or single object
        const bookingsToReturn = Array.isArray(req.body) ? req.body : [req.body];
        
        // Define fine parameters
        const finePerDay = 5;  // Fine per overdue day
        
        const results = [];
        const errors = [];
        
        // Process each booking
        for (const booking of bookingsToReturn) {
            const { booking_id, book_id } = booking;
            
            // Validate input
            if (!booking_id || !book_id) {
                errors.push({
                    booking_id: booking_id || "unknown",
                    book_id: book_id || "unknown",
                    message: "Both booking_id and book_id are required"
                });
                continue;
            }
            
            // Use a connection from the pool for transaction
            const connection = await new Promise((resolve, reject) => {
                db.getConnection((err, conn) => {
                    if (err) reject(err);
                    else resolve(conn);
                });
            });
            
            try {
                // Start transaction for this booking
                await new Promise((resolve, reject) => {
                    connection.beginTransaction(err => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
                
                // 1. Fetch the booking details
                const bookingDetails = await new Promise((resolve, reject) => {
                    connection.query(
                        `SELECT booking_id, book_id, booking_date, user_id, expected_return_date 
                        FROM bookings 
                        WHERE booking_id = ? 
                        AND actual_return_date IS NULL`,
                        [booking_id],
                        (err, results) => {
                            if (err) reject(err);
                            else resolve(results);
                        }
                    );
                });

                // If booking not found, or already returned
                if (bookingDetails.length === 0) {
                    await new Promise((resolve, reject) => {
                        connection.rollback(err => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });
                    
                    connection.release();
                    errors.push({
                        booking_id,
                        book_id,
                        message: "Booking not found or already returned"
                    });
                    continue;
                }

                const bookingInfo = bookingDetails[0];
                const expectedReturnDate = new Date(bookingInfo.expected_return_date);
                const currentDate = new Date();
                let fine = 0;
                let daysOverdue = 0;

                // 2. Check if the book is overdue
                if (currentDate > expectedReturnDate) {
                    const timeDifference = currentDate - expectedReturnDate;
                    daysOverdue = Math.floor(timeDifference / (1000 * 3600 * 24));
                    fine = daysOverdue * finePerDay;  // Calculate the fine
                }

                // 3. Update booking's actual_return_date
                const updateBookingResult = await new Promise((resolve, reject) => {
                    connection.query(
                        `UPDATE bookings 
                        SET actual_return_date = NOW()
                        WHERE booking_id = ?`,
                        [booking_id],
                        (err, results) => {
                            if (err) reject(err);
                            else resolve(results);
                        }
                    );
                });

                if (updateBookingResult.affectedRows === 0) {
                    await new Promise((resolve, reject) => {
                        connection.rollback(err => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });
                    
                    connection.release();
                    errors.push({
                        booking_id,
                        book_id,
                        message: "Failed to update booking return date"
                    });
                    continue;
                }

                // 4. If there's a fine, create a record in the fines table
                if (fine > 0) {
                    const insertFineResult = await new Promise((resolve, reject) => {
                        connection.query(
                            `INSERT INTO fines 
                            (user_id, fine_type, description, amount, days_overdue, status, created_at) 
                            VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                            [
                                bookingInfo.user_id,
                                "Overdue",
                                `Overdue fine for book ID ${book_id}`,
                                fine,
                                daysOverdue,
                                "pending",
                            ],
                            (err, results) => {
                                if (err) reject(err);
                                else resolve(results);
                            }
                        );
                    });

                    if (insertFineResult.affectedRows === 0) {
                        await new Promise((resolve, reject) => {
                            connection.rollback(err => {
                                if (err) reject(err);
                                else resolve();
                            });
                        });
                        
                        connection.release();
                        errors.push({
                            booking_id,
                            book_id,
                            message: "Failed to create fine record"
                        });
                        continue;
                    }
                }

                // 5. Update available copies in the inventory (book return)
                const updateInventoryResult = await new Promise((resolve, reject) => {
                    connection.query(
                        `UPDATE books 
                        SET available_copies = available_copies + 1 
                        WHERE book_id = ?`,
                        [book_id],
                        (err, results) => {
                            if (err) reject(err);
                            else resolve(results);
                        }
                    );
                });

                if (updateInventoryResult.affectedRows === 0) {
                    await new Promise((resolve, reject) => {
                        connection.rollback(err => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });
                    
                    connection.release();
                    errors.push({
                        booking_id,
                        book_id,
                        message: "Book not found in inventory"
                    });
                    continue;
                }

                // Commit transaction if all queries succeed
                await new Promise((resolve, reject) => {
                    connection.commit(err => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
                
                connection.release();
                
                // Add to successful results
                results.push({
                    success: true,
                    booking_id,
                    book_id,
                    fine,
                    days_overdue: daysOverdue,
                    returned_at: new Date().toISOString()
                });
                
            } catch (error) {
                // Rollback the transaction in case of any error
                await new Promise((resolve, reject) => {
                    connection.rollback(err => {
                        if (err) reject(err);
                        else resolve();
                    });
                }).catch(err => console.error("Rollback error:", err));
                
                connection.release();
                console.error("Return error for booking", booking_id, ":", error);
                errors.push({
                    booking_id,
                    book_id,
                    message: "Internal server error during return process"
                });
            }
        }
        
        // Return final results
        res.json({
            success: errors.length === 0,
            message: `${results.length} book(s) returned successfully${errors.length > 0 ? ', with ' + errors.length + ' error(s)' : ''}`,
            results,
            errors: errors.length > 0 ? errors : undefined
        });
        
    } catch (error) {
        console.error("Global return error:", error);
        res.status(500).json({
            success: false,
            message: "Internal server error during return process",
            error: error.message
        });
    }
});


// Route to render the borrow page
app.get("/borrow", requireAuth, (req, res) => {
    res.render("borrow", { user: req.session.user });
});

// Route to render the cart page
app.get("/cart", requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        
        const [cartItems] = await db.execute(`
            SELECT bc.cart_id, b.title, b.book_id, bc.quantity 
            FROM books_cart bc
            JOIN books b ON bc.book_id = b.book_id
            WHERE bc.user_id = ?
        `, [userId]);
        
        res.render("cart", { 
            user: req.session.user,
            cartItems
        });
    } catch (err) {
        console.error("Database error:", err);
        // Instead of rendering "error" view, render the cart page with error information
        res.render("cart", { 
            user: req.session.user,
            error: true, 
            errorMessage: "Error fetching cart. Please try again later.",
            cartItems: []
        });
    }
});
// Route to render the return books page
// Route to render the return books page
app.get("/return", requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        
        // Fetch active books (not yet returned)
        const [books] = await db.execute(`
            SELECT b.book_id, b.title, b.category, bk.booking_id, 
                   bk.booking_date, bk.expected_return_date
            FROM bookings bk
            JOIN books b ON bk.book_id = b.book_id
            WHERE bk.user_id = ? AND bk.actual_return_date IS NULL
        `, [userId]);
        
        // Calculate overdue days and fines
        let totalFine = 0;
        const activeBooks = books.map(book => {
            const bookingDate = new Date(book.booking_date);
            const expectedReturnDate = new Date(book.expected_return_date);
            const currentDate = new Date();
            
            let daysOverdue = 0;
            let fine = 0;
            
            if (currentDate > expectedReturnDate) {
                const timeDifference = currentDate - expectedReturnDate;
                daysOverdue = Math.floor(timeDifference / (1000 * 3600 * 24));
                fine = daysOverdue * 5; // $5 per overdue day
                totalFine += fine;
            }
            
            return {
                ...book,
                daysOverdue,
                fine: fine > 0 ? fine.toFixed(2) : 0
            };
        });
        
        res.render("return", {
            user: req.session.user,
            activeBooks,
            totalFine: totalFine.toFixed(2)
        });
    } catch (err) {
        console.error("Database error:", err);
        // Instead of rendering "error" view, render the return page with error information
        res.render("return", { 
            user: req.session.user,
            error: true, 
            errorMessage: "Error fetching books to return. Please try again later.",
            activeBooks: [],
            totalFine: "0.00"
        });
    }
});
// Route to render the history page
app.get("/history", requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = 10; // Items per page
        const offset = (page - 1) * limit;
        
        // Get total count for pagination
        const [countResult] = await db.execute(`
            SELECT COUNT(*) as total FROM bookings WHERE user_id = ?
        `, [userId]);
        
        const total = countResult[0].total;
        const totalPages = Math.ceil(total / limit);
        
        // Build query with limit and offset directly in the SQL string
        const query = `
            SELECT b.book_id, b.title, b.category, 
                   bk.booking_id, bk.booking_date, bk.expected_return_date, 
                   bk.actual_return_date as return_date, 
                   DATEDIFF(IFNULL(bk.actual_return_date, NOW()), bk.booking_date) as duration_days,
                   CASE 
                     WHEN bk.actual_return_date IS NULL AND NOW() > bk.expected_return_date THEN 'Overdue'
                     WHEN bk.actual_return_date IS NULL THEN 'Active'
                    ELSE 'Returned'
                   END as status
            FROM bookings bk
            JOIN books b ON bk.book_id = b.book_id
            WHERE bk.user_id = ?
            ORDER BY bk.booking_date DESC
            LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
        `;
        
        // Execute with only userId as parameter
        const [bookings] = await db.execute(query, [userId]);
        
        res.render("history", {
            user: req.session.user,
            bookings,
            pagination: total > limit,
            currentPage: page,
            totalPages,
            prevPage: page > 1 ? page - 1 : null,
            nextPage: page < totalPages ? page + 1 : null,
            isFirstPage: page === 1,
            isLastPage: page >= totalPages
        });
    } catch (err) {
        console.error("Database error:", err);
        // Render history template with error information
        res.render("history", {
            user: req.session.user,
            error: true,
            errorMessage: "Error fetching booking history: " + err.message,
            bookings: [],
            pagination: false
        });
    }
});
// Admin route to view users
app.get('/admin/users', async (req, res) => {
    try {
    const result = await pool.query('SELECT id, username, fullname, email, "phoneNumber", role, status, created_at FROM users ORDER BY created_at DESC');
    res.render('admin/users', { users: result.rows });
    } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).send('Server error');
    }
});
// 🚀 Start Server
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));