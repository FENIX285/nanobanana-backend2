// server.js - Backend para gestionar créditos y usuarios
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const app = express();
const port = process.env.PORT || 3000;

// Conexión a MongoDB Atlas
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  console.error('Error: MONGODB_URI no está definida en las variables de entorno');
  process.exit(1);
}

mongoose.connect(mongoUri)
  .then(() => console.log('✅ Conectado a MongoDB Atlas'))
  .catch(err => {
    console.error('❌ Error al conectar con MongoDB Atlas:', err.message);
    process.exit(1);
  });

// Esquema de usuario
const userSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  credits: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  lastLogin: Date
});

const User = mongoose.model('User', userSchema);

// Middleware CORS y rate limiting
app.use(cors({
  origin: ['https://localhost', 'https://your-plugin-domain.com'], // Ajustar según necesidad
  methods: ['GET', 'POST'],
  credentials: true
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // límite de 100 solicitudes por ventana
  message: 'Demasiadas solicitudes desde esta IP, por favor intenta de nuevo en 15 minutos'
});
app.use(limiter);

// Middleware para verificar token
const verifyToken = async (req, res, next) => {
  const token = req.headers['x-plugin-token'] || req.query.token;
  
  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    const user = await User.findOne({ token });
    if (!user) {
      return res.status(403).json({ error: 'Token inválido' });
    }
    
    // Actualizar última conexión
    user.lastLogin = new Date();
    await user.save();
    
    req.user = user;
    next();
  } catch (error) {
    console.error('Error al verificar token:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Endpoint para verificar token y obtener créditos
app.get('/api/verify', verifyToken, (req, res) => {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    return res.status(500).json({ error: 'Error de configuración: API key de Gemini no disponible' });
  }
  
  res.json({
    success: true,
    credits: req.user.credits,
    geminiApiKey: geminiApiKey
  });
});

// Endpoint para descontar créditos
app.post('/api/consume-credits', verifyToken, async (req, res) => {
  try {
    const { amount } = req.body;
    
    if (!amount || amount <= 0 || isNaN(amount)) {
      return res.status(400).json({ error: 'Monto de créditos inválido' });
    }
    
    if (req.user.credits < amount) {
      return res.status(400).json({ error: 'Créditos insuficientes' });
    }
    
    req.user.credits -= amount;
    await req.user.save();
    
    res.json({
      success: true,
      remainingCredits: req.user.credits
    });
  } catch (error) {
    console.error('Error al descontar créditos:', error);
    res.status(500).json({ error: 'Error interno al descontar créditos' });
  }
});

// Endpoint para administración (solo para uso manual por el desarrollador)
app.post('/api/admin/add-credits', async (req, res) => {
  const adminToken = req.headers['x-admin-token'] || req.query.adminToken;
  
  if (adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Token de administrador inválido' });
  }
  
  try {
    const { userToken, amount } = req.body;
    
    if (!userToken || !amount || amount <= 0 || isNaN(amount)) {
      return res.status(400).json({ error: 'Parámetros inválidos' });
    }
    
    const user = await User.findOne({ token: userToken });
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    user.credits += amount;
    await user.save();
    
    res.json({
      success: true,
      message: `Se han añadido ${amount} créditos al usuario`,
      user: {
        token: user.token,
        credits: user.credits
      }
    });
  } catch (error) {
    console.error('Error al añadir créditos:', error);
    res.status(500).json({ error: 'Error interno al añadir créditos' });
  }
});

// Endpoint para crear nuevo usuario (token)
app.post('/api/admin/create-user', async (req, res) => {
  const adminToken = req.headers['x-admin-token'] || req.query.adminToken;
  
  if (adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Token de administrador inválido' });
  }
  
  try {
    const { initialCredits = 0 } = req.body;
    
    // Generar token único
    const token = require('crypto').randomBytes(16).toString('hex');
    
    // Crear usuario
    const user = new User({
      token,
      credits: initialCredits
    });
    
    await user.save();
    
    res.json({
      success: true,
      message: 'Usuario creado exitosamente',
      user: {
        token,
        credits: initialCredits
      }
    });
  } catch (error) {
    console.error('Error al crear usuario:', error);
    res.status(500).json({ error: 'Error interno al crear usuario' });
  }
});

// Endpoint para obtener todos los usuarios (solo admin)
app.get('/api/admin/users', async (req, res) => {
  const adminToken = req.headers['x-admin-token'] || req.query.adminToken;
  
  if (adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Token de administrador inválido' });
  }
  
  try {
    const users = await User.find({}, 'token credits createdAt lastLogin').sort({ createdAt: -1 });
    res.json({
      success: true,
      users
    });
  } catch (error) {
    console.error('Error al obtener usuarios:', error);
    res.status(500).json({ error: 'Error interno al obtener usuarios' });
  }
});

// Manejo de errores
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// Iniciar servidor
app.listen(port, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${port}`);
  console.log(`🔗 URL base: ${process.env.RAILWAY_STATIC_URL || `http://localhost:${port}`}`);
  
  // Verificar que las variables críticas estén definidas
  const requiredEnvVars = ['MONGODB_URI', 'GEMINI_API_KEY', 'ADMIN_TOKEN'];
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
  
  if (missingVars.length > 0) {
    console.warn('⚠️ Variables de entorno faltantes:', missingVars.join(', '));
    console.warn('Esto puede causar errores en tiempo de ejecución');
  }
});

// Manejo de cierre elegante
process.on('SIGINT', async () => {
  console.log('CloseOperation: Cerrando conexiones...');
  await mongoose.connection.close();
  console.log('CloseOperation: MongoDB desconectado');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('CloseOperation: Cerrando conexiones...');
  await mongoose.connection.close();
  console.log('CloseOperation: MongoDB desconectado');
  process.exit(0);
});
