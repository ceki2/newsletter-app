const express = require('express');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(cors());

// PostgreSQL baza
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Inicijalizacija baze
async function initializeDatabase() {
  try {
    // Tablica klijenata
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        company TEXT,
        subscribed BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Tablica newslettera
    await pool.query(`
      CREATE TABLE IF NOT EXISTS newsletters (
        id SERIAL PRIMARY KEY,
        subject TEXT NOT NULL,
        content TEXT NOT NULL,
        sent_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
}

// Email konfiguracija
const createTransporter = () => {
  return nodemailer.createTransporter({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
};

// 📊 API RUTE

// Test ruta
app.get('/api/test', (req, res) => {
  res.json({ message: '🚀 Newsletter App is running!', timestamp: new Date().toISOString() });
});

// Dodaj novog klijenta
app.post('/api/clients', async (req, res) => {
  try {
    const { email, name, company } = req.body;
    
    const result = await pool.query(
      `INSERT INTO clients (email, name, company) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (email) DO NOTHING 
       RETURNING *`,
      [email, name, company]
    );
    
    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'Email već postoji' });
    }
    
    res.json({ 
      message: 'Klijent uspješno dodan',
      client: result.rows[0]
    });
  } catch (error) {
    console.error('Error adding client:', error);
    res.status(500).json({ error: error.message });
  }
});

// Dohvati sve klijente
app.get('/api/clients', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clients ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Kreiraj newsletter
app.post('/api/newsletters', async (req, res) => {
  try {
    const { subject, content } = req.body;
    
    const result = await pool.query(
      'INSERT INTO newsletters (subject, content) VALUES ($1, $2) RETURNING *',
      [subject, content]
    );
    
    res.json({ 
      message: 'Newsletter kreiran',
      newsletter: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dohvati sve newslettere
app.get('/api/newsletters', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM newsletters ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Pošalji newsletter
app.post('/api/newsletters/:id/send', async (req, res) => {
  try {
    const newsletterId = req.params.id;
    
    // Dohvati newsletter
    const newsletterResult = await pool.query('SELECT * FROM newsletters WHERE id = $1', [newsletterId]);
    if (newsletterResult.rows.length === 0) {
      return res.status(404).json({ error: 'Newsletter nije pronađen' });
    }
    
    const newsletter = newsletterResult.rows[0];
    
    // Dohvati pretplaćene klijente
    const clientsResult = await pool.query('SELECT * FROM clients WHERE subscribed = true');
    const clients = clientsResult.rows;
    
    const transporter = createTransporter();
    let sentCount = 0;
    
    // Test mode - samo prva 3 emaila ako nije konfiguriran email
    const testMode = !process.env.EMAIL_USER;
    const maxEmails = testMode ? 3 : clients.length;
    
    for (let i = 0; i < maxEmails; i++) {
      const client = clients[i];
      try {
        if (!testMode) {
          await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: client.email,
            subject: newsletter.subject,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2>${newsletter.subject}</h2>
                <div>${newsletter.content.replace(/\n/g, '<br>')}</div>
                <hr>
                <p style="color: #666; font-size: 12px;">
                  Pošaljeno putem Newsletter App<br>
                  <a href="${req.headers.origin}/unsubscribe?email=${client.email}">Otkaži pretplatu</a>
                </p>
              </div>
            `
          });
        }
        sentCount++;
        console.log(`✅ Email sent to: ${client.email}`);
      } catch (emailError) {
        console.error(`❌ Error sending to ${client.email}:`, emailError.message);
      }
    }
    
    // Ažuriraj broj poslanih
    await pool.query('UPDATE newsletters SET sent_count = $1 WHERE id = $2', [sentCount, newsletterId]);
    
    const message = testMode 
      ? `📧 TEST MODE: Newsletter spreman za slanje na ${sentCount} emailova (email nije konfiguriran)`
      : `✅ Newsletter poslan na ${sentCount} email adresa`;
    
    res.json({ 
      message,
      sent: sentCount,
      total: clients.length,
      testMode
    });
  } catch (error) {
    console.error('Error sending newsletter:', error);
    res.status(500).json({ error: error.message });
  }
});

// Statistikа
app.get('/api/stats', async (req, res) => {
  try {
    const clientsResult = await pool.query('SELECT COUNT(*) as count FROM clients');
    const subscribedResult = await pool.query('SELECT COUNT(*) as count FROM clients WHERE subscribed = true');
    const newslettersResult = await pool.query('SELECT COUNT(*) as count FROM newsletters');
    
    res.json({
      total_clients: parseInt(clientsResult.rows[0].count),
      subscribed_clients: parseInt(subscribedResult.rows[0].count),
      total_newsletters: parseInt(newslettersResult.rows[0].count)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// Provjera DATABASE_URL
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL nije postavljen!');
  console.log('Provjeri Environment Variables u Render dashboardu');
}

// PostgreSQL baza
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test baza konekcije
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection error:', err.message);
    console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'Postavljen' : 'Nije postavljen');
  } else {
    console.log('✅ Database connected successfully');
    release();
  }
});
// Otkaži pretplatu
app.post('/api/unsubscribe', async (req, res) => {
  try {
    const { email } = req.body;
    
    await pool.query('UPDATE clients SET subscribed = false WHERE email = $1', [email]);
    
    res.json({ message: 'Pretplata uspješno otkazana' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serviraj frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Pokreni server
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await initializeDatabase();
});
