import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db';
import { signToken } from '../auth';
import { ApiError } from '../errors';

const router = Router();

const credsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

router.post('/register', async (req, res, next) => {
  try {
    const { email, password } = credsSchema.parse(req.body);
    const existing = await pool.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) throw new ApiError(409, 'Email already registered');

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, hash]
    );
    const token = signToken(rows[0].id);
    res.status(201).json({ token, user: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = credsSchema.parse(req.body);
    const { rows } = await pool.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email]);
    if (rows.length === 0) throw new ApiError(401, 'Invalid email or password');

    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) throw new ApiError(401, 'Invalid email or password');

    const token = signToken(rows[0].id);
    res.json({ token, user: { id: rows[0].id, email: rows[0].email } });
  } catch (err) {
    next(err);
  }
});

export default router;
