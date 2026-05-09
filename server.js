const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ============ MEMBERS API ============

// Get all members
app.get('/api/members', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*, 
             COALESCE(json_agg(f.*) FILTER (WHERE f.id IS NOT NULL), '[]') as family
      FROM members m
      LEFT JOIN family_members f ON m.id = f.member_id
      GROUP BY m.id
      ORDER BY m.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get single member
app.get('/api/members/:id', async (req, res) => {
  try {
    const memberResult = await pool.query('SELECT * FROM members WHERE id = $1', [req.params.id]);
    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const familyResult = await pool.query('SELECT * FROM family_members WHERE member_id = $1', [req.params.id]);
    
    const member = memberResult.rows[0];
    member.family = familyResult.rows;
    res.json(member);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create member
app.post('/api/members', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { name, dob, gender, religion, nationality, ninNumber, area, village, 
            phone, phone2, email, occupation, education, maritalStatus, notes, photo, family } = req.body;
    
    // Generate member ID
    const idResult = await client.query('SELECT COALESCE(MAX(id), 0) + 1 as next_id FROM members');
    const nextId = idResult.rows[0].next_id;
    const memberId = `BMMU-${String(nextId).padStart(5, '0')}`;
    
    // Insert member
    const memberResult = await client.query(
      `INSERT INTO members (member_id, name, dob, gender, religion, nationality, nin_number, area, 
       village, phone, phone2, email, occupation, education, marital_status, notes, photo, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
       RETURNING *`,
      [memberId, name, dob, gender, religion, nationality, ninNumber, area, village, phone, 
       phone2, email, occupation, education, maritalStatus, notes, photo]
    );
    
    const newMember = memberResult.rows[0];
    
    // Insert family members
    if (family && family.length > 0) {
      for (const fam of family) {
        await client.query(
          `INSERT INTO family_members (member_id, name, relation, dob, phone)
           VALUES ($1, $2, $3, $4, $5)`,
          [newMember.id, fam.name, fam.relation, fam.dob, fam.phone]
        );
      }
    }
    
    await client.query('COMMIT');
    
    // Fetch with family
    const finalResult = await pool.query(`
      SELECT m.*, COALESCE(json_agg(f.*) FILTER (WHERE f.id IS NOT NULL), '[]') as family
      FROM members m
      LEFT JOIN family_members f ON m.id = f.member_id
      WHERE m.id = $1
      GROUP BY m.id
    `, [newMember.id]);
    
    res.json(finalResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Update member
app.put('/api/members/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { name, dob, gender, religion, nationality, ninNumber, area, village, 
            phone, phone2, email, occupation, education, maritalStatus, notes, photo, family } = req.body;
    
    await client.query(
      `UPDATE members SET name=$1, dob=$2, gender=$3, religion=$4, nationality=$5, 
       nin_number=$6, area=$7, village=$8, phone=$9, phone2=$10, email=$11, 
       occupation=$12, education=$13, marital_status=$14, notes=$15, photo=$16, updated_at=NOW()
       WHERE id=$17`,
      [name, dob, gender, religion, nationality, ninNumber, area, village, phone, phone2, 
       email, occupation, education, maritalStatus, notes, photo, req.params.id]
    );
    
    // Update family members (delete and reinsert)
    await client.query('DELETE FROM family_members WHERE member_id = $1', [req.params.id]);
    
    if (family && family.length > 0) {
      for (const fam of family) {
        await client.query(
          `INSERT INTO family_members (member_id, name, relation, dob, phone)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.params.id, fam.name, fam.relation, fam.dob, fam.phone]
        );
      }
    }
    
    await client.query('COMMIT');
    
    const finalResult = await pool.query(`
      SELECT m.*, COALESCE(json_agg(f.*) FILTER (WHERE f.id IS NOT NULL), '[]') as family
      FROM members m
      LEFT JOIN family_members f ON m.id = f.member_id
      WHERE m.id = $1
      GROUP BY m.id
    `, [req.params.id]);
    
    res.json(finalResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Delete member
app.delete('/api/members/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM family_members WHERE member_id = $1', [req.params.id]);
    await client.query('DELETE FROM members WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ============ STAFF API ============

// Get all staff
app.get('/api/staff', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM staff ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create staff
app.post('/api/staff', async (req, res) => {
  try {
    const { name, username, password, email, phone, role, active, permissions, avatar } = req.body;
    
    // Generate staff ID
    const idResult = await pool.query('SELECT COALESCE(MAX(id), 0) + 1 as next_id FROM staff');
    const nextId = idResult.rows[0].next_id;
    const staffId = `STF-${String(nextId).padStart(4, '0')}`;
    
    const result = await pool.query(
      `INSERT INTO staff (staff_id, name, username, password, email, phone, role, active, permissions, avatar, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       RETURNING *`,
      [staffId, name, username, password, email, phone, role, active !== false, permissions || [], avatar]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update staff
app.put('/api/staff/:id', async (req, res) => {
  try {
    const { name, username, password, email, phone, role, active, permissions, avatar } = req.body;
    
    await pool.query(
      `UPDATE staff SET name=$1, username=$2, password=$3, email=$4, phone=$5, 
       role=$6, active=$7, permissions=$8, avatar=$9, updated_at=NOW()
       WHERE id=$10`,
      [name, username, password, email, phone, role, active !== false, permissions || [], avatar, req.params.id]
    );
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete staff
app.delete('/api/staff/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM staff WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await pool.query(
      'SELECT * FROM staff WHERE username = $1 AND password = $2 AND active = true',
      [username, password]
    );
    
    if (result.rows.length > 0) {
      const user = result.rows[0];
      delete user.password; // Remove password from response
      res.json(user);
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ STATISTICS ============

app.get('/api/stats', async (req, res) => {
  try {
    const total = await pool.query('SELECT COUNT(*) FROM members');
    const males = await pool.query("SELECT COUNT(*) FROM members WHERE gender = 'Male'");
    const females = await pool.query("SELECT COUNT(*) FROM members WHERE gender = 'Female'");
    const thisMonth = await pool.query(
      "SELECT COUNT(*) FROM members WHERE DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())"
    );
    const byArea = await pool.query(
      "SELECT area, COUNT(*) as count FROM members WHERE area IS NOT NULL GROUP BY area ORDER BY count DESC"
    );
    const byGender = await pool.query("SELECT gender, COUNT(*) as count FROM members GROUP BY gender");
    
    res.json({
      total: parseInt(total.rows[0].count),
      males: parseInt(males.rows[0].count),
      females: parseInt(females.rows[0].count),
      thisMonth: parseInt(thisMonth.rows[0].count),
      byArea: byArea.rows,
      byGender: byGender.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve HTML for all other routes (SPA support)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize database tables
async function initDatabase() {
  try {
    // Create members table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        member_id VARCHAR(20) UNIQUE NOT NULL,
        name VARCHAR(200) NOT NULL,
        dob DATE,
        gender VARCHAR(10),
        religion VARCHAR(50),
        nationality VARCHAR(50),
        nin_number VARCHAR(50),
        area VARCHAR(100),
        village VARCHAR(100),
        phone VARCHAR(20),
        phone2 VARCHAR(20),
        email VARCHAR(100),
        occupation VARCHAR(100),
        education VARCHAR(100),
        marital_status VARCHAR(50),
        notes TEXT,
        photo TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP
      )
    `);
    
    // Create family members table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS family_members (
        id SERIAL PRIMARY KEY,
        member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
        name VARCHAR(200) NOT NULL,
        relation VARCHAR(50),
        dob DATE,
        phone VARCHAR(20),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Create staff table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS staff (
        id SERIAL PRIMARY KEY,
        staff_id VARCHAR(20) UNIQUE NOT NULL,
        name VARCHAR(200) NOT NULL,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(100) NOT NULL,
        email VARCHAR(100),
        phone VARCHAR(20),
        role VARCHAR(50) DEFAULT 'staff',
        active BOOLEAN DEFAULT true,
        permissions JSONB DEFAULT '[]',
        avatar TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP
      )
    `);
    
    // Create default admin if not exists
    const adminCheck = await pool.query("SELECT * FROM staff WHERE username = 'admin'");
    if (adminCheck.rows.length === 0) {
      await pool.query(`
        INSERT INTO staff (staff_id, name, username, password, role, active, permissions)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, ['STF-0001', 'System Administrator', 'admin', 'bmmu2025', 'superadmin', true, '[]']);
      console.log('Default admin created: admin / bmmu2025');
    }
    
    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}

// Start server
initDatabase().then(() => {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
});