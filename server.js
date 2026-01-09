require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion } = require('mongodb');
const app = express();
const port = process.env.PORT || 3000;

// ========================================
// IMPORTAR FETCH CORRECTAMENTE PARA NODE.JS
// ========================================
let fetch;
try {
  // Intentar importar node-fetch v2 (CommonJS)
  fetch = require('node-fetch');
  console.log('✅ node-fetch v2 importado correctamente');
} catch (e1) {
  try {
    // Intentar importar node-fetch v3+ (ESM)
    fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    console.log('✅ node-fetch v3+ importado correctamente');
  } catch (e2) {
    console.error('❌ Error importando node-fetch:', e2.message);
    console.error('Solución: Ejecuta "npm install node-fetch@2" en tu proyecto');
    process.exit(1);
  }
}

// ========================================
// VERIFICACIÓN INICIAL DE VARIABLES CLAVE
// ========================================
const criticalEnvVars = ['MONGODB_URI', 'GEMINI_API_KEY'];
const missingVars = criticalEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error('❌ ERROR FATAL: Variables de entorno faltantes:');
  missingVars.forEach(varName => console.error(`   - ${varName}`));
  console.error('Solución: Configura estas variables en Railway > Variables de entorno');
  process.exit(1);
}

console.log('✅ Variables de entorno críticas verificadas');
console.log(`🔧 MongoDB URI configurada: ${process.env.MONGODB_URI.replace(/\/\/(.*?):(.*?)@/, '//[USER]:[PASSWORD]@')}`);
console.log(`🔑 Gemini API Key presente: ${process.env.GEMINI_API_KEY.substring(0, 8)}...`);

// ========================================
// CONFIGURACIÓN DE MIDDLEWARES CON LÍMITES AMPLIOS
// ========================================
// Configurar límites antes de cualquier otro middleware
app.use(express.json({ 
  limit: '50mb', // Aumentado a 50MB para manejar imágenes grandes
  strict: false,
  verify: (req, res, buf) => {
    req.rawBody = buf; // Guardar body crudo para debugging
  }
}));

app.use(express.urlencoded({
  limit: '50mb',
  extended: true,
  parameterLimit: 50000
}));

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
  maxAge: 86400 // 24 horas de caché para preflight requests
}));

// ========================================
// CONEXIÓN A MONGODB CON REINTENTOS
// ========================================
let dbClient = null;
let dbCollections = null;

const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 segundos entre reintentos

async function connectToDatabase(retryCount = 0) {
  try {
    if (dbClient && dbClient.topology && dbClient.topology.isConnected()) {
      console.log('✅ Usando conexión MongoDB existente');
      return dbCollections;
    }

    console.log(`🔌 Intentando conectar a MongoDB (intento ${retryCount + 1}/${MAX_RETRIES})...`);
    
    const client = new MongoClient(process.env.MONGODB_URI, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      heartbeatFrequencyMS: 10000,
      retryWrites: true,
      retryReads: true
    });

    await client.connect();
    
    // Verificar conexión
    const pingResult = await client.db("admin").command({ ping: 1 });
    console.log('🏓 MongoDB ping exitoso:', pingResult);

    const db = client.db("nano_banana");
    const usersCollection = db.collection("users");
    const transactionsCollection = db.collection("transactions");
    
    // Asegurar índices
    await Promise.all([
      usersCollection.createIndex({ token: 1 }, { unique: true, background: true }),
      usersCollection.createIndex({ createdAt: 1 }, { background: true }),
      transactionsCollection.createIndex({ userId: 1 }, { background: true }),
      transactionsCollection.createIndex({ timestamp: 1 }, { background: true })
    ]);
    
    console.log('✅ Índices de MongoDB verificados/creados');
    
    dbClient = client;
    dbCollections = { users: usersCollection, transactions: transactionsCollection };
    
    return dbCollections;
  } catch (error) {
    console.error(`❌ Error conectando a MongoDB (intento ${retryCount + 1}):`, error.message);
    
    // Cerrar cliente si existe
    if (dbClient) {
      try { await dbClient.close(); } catch (closeError) { /* Ignorar */ }
      dbClient = null;
      dbCollections = null;
    }
    
    // Reintentar si quedan intentos
    if (retryCount < MAX_RETRIES - 1) {
      console.log(`⏳ Reintentando en ${RETRY_DELAY/1000} segundos...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return connectToDatabase(retryCount + 1);
    }
    
    throw new Error(`Error persistente conectando a MongoDB: ${error.message}`);
  }
}

// ========================================
// FUNCIONES DE NEGOCIO
// ========================================
async function verifyUserToken(token) {
  if (!token || typeof token !== 'string' || token.trim() === '') {
    throw new Error('Token inválido o vacío');
  }

  try {
    const { users } = await connectToDatabase();
    const user = await users.findOne({ token: token.trim() });
    
    if (!user) {
      throw new Error('Usuario no encontrado con este token');
    }
    
    // Actualizar última conexión
    await users.updateOne(
      { _id: user._id },
      { $set: { lastLogin: new Date() } }
    );
    
    return user;
  } catch (error) {
    console.error('❌ Error en verifyUserToken:', error.message);
    throw error;
  }
}

async function generateImageWithGemini(payload, instruction) {
  try {
    const { model, prompt, operation, referenceImages, baseImage, maskImage, aspectRatio, resolution, candidateCount = 1 } = payload;
    
    // Validar parámetros críticos
    if (!model || !prompt) {
      throw new Error('Modelo y prompt son requeridos para generar imagen');
    }
    
    // Preparar partes del contenido
    const parts = [];
    
    // Instrucciones forzadas
    parts.push({ text: instruction });
    
    // Imágenes de referencia
    if (Array.isArray(referenceImages) && referenceImages.length > 0) {
      for (let i = 0; i < referenceImages.length; i++) {
        const ref = referenceImages[i];
        if (!ref?.data || !ref?.mimeType) continue;
        
        parts.push({
          text: `REFERENCE_${i + 1}: guía SOLO de estilo/continuidad. Usa su paleta de color, iluminación y textura, pero NO copies su geometría ni encuadre 1:1.`
        });
        parts.push({
          inline_data: {
            mime_type: ref.mimeType,
            data: ref.data
          }
        });
      }
    }
    
    // Imágenes específicas según operación
    if (operation === 'inpaint' && maskImage && baseImage) {
      // Máscara
      if (maskImage?.data && maskImage?.mimeType) {
        parts.push({ text: "MASK: Define el área a modificar. BLANCO = zona a modificar, NEGRO = zona a conservar intacta." });
        parts.push({
          inline_data: {
            mime_type: maskImage.mimeType,
            data: maskImage.data
          }
        });
      }
      
      // Imagen base
      if (baseImage?.data && baseImage?.mimeType) {
        parts.push({ text: "BASE_CROP: La imagen principal que DEBES editar. Es la última imagen antes de este texto." });
        parts.push({
          inline_data: {
            mime_type: baseImage.mimeType,
            data: baseImage.data
          }
        });
      }
    } 
    else if (operation === 'edit' && baseImage) {
      if (baseImage?.data && baseImage?.mimeType) {
        parts.push({ text: "BASE_IMAGE: imagen a editar sin selección activa." });
        parts.push({
          inline_data: {
            mime_type: baseImage.mimeType,
            data: baseImage.data
          }
        });
      }
    }
    
    // Prompt del usuario
    parts.push({ text: `PROMPT_USUARIO:\n${prompt}` });
    
    // Configuración de generación - CORREGIDO para usar candidateCount solicitado
    const genConfig = {
      responseModalities: ["IMAGE"],
      candidateCount: Math.min(Math.max(candidateCount, 1), 4) // Asegurar límite entre 1-4
    };
    
    // Configuración específica por modelo
    if (model === "gemini-2.5-flash-image" && aspectRatio) {
      genConfig.imageConfig = { aspectRatio };
    } 
    else if (model === "gemini-3-pro-image-preview") {
      const imgCfg = {};
      if (aspectRatio) imgCfg.aspectRatio = aspectRatio;
      if (resolution) imgCfg.imageSize = resolution;
      if (Object.keys(imgCfg).length > 0) {
        genConfig.imageConfig = imgCfg;
      }
    }
    
    console.log(`🚀 Llamando a Gemini API con modelo: ${model}, operación: ${operation}, candidatos: ${genConfig.candidateCount}`);
    console.log(`📝 Prompt: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`);
    
    // Llamada a API con timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000); // 90 segundos
    
    try {
      // Asegurarse de que fetch esté disponible
      if (typeof fetch !== 'function') {
        throw new Error('La función fetch no está disponible. Verifica la instalación de node-fetch.');
      }
      
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: genConfig
          }),
          signal: controller.signal
        }
      );
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        let errorData;
        try {
          errorData = await response.json();
        } catch (parseError) {
          errorData = { error: { message: `Error ${response.status}: ${response.statusText}` } };
        }
        
        const errorMessage = errorData.error?.message || `Error ${response.status}: ${response.statusText}`;
        console.error(`❌ Error de Gemini API (${response.status}):`, errorMessage);
        
        // Errores específicos de contenido inseguro
        if (errorMessage.includes('unsafe content') || errorMessage.includes('safety')) {
          throw new Error('Contenido rechazado por políticas de seguridad. Intenta con un prompt diferente.');
        }
        
        throw new Error(`Error de Gemini API: ${errorMessage}`);
      }
      
      const data = await response.json();
      console.log('✅ Respuesta exitosa de Gemini API');
      
      // CORREGIDO: devolver múltiples candidatos si existen
      const candidates = data.candidates || [];
      if (candidates.length === 0) {
        throw new Error('No se obtuvieron candidatos en la respuesta de Gemini');
      }
      
      // Procesar todos los candidatos válidos
      const imageResults = [];
      for (const candidate of candidates) {
        if (candidate.finishReason === 'IMAGE_SAFETY') {
          console.warn('⚠️ Candidato rechazado por motivos de seguridad');
          continue;
        }
        
        const imagePart = candidate.content?.parts?.find(p => p.inlineData?.data);
        if (!imagePart) {
          console.warn('⚠️ Candidato sin imagen válida');
          continue;
        }
        
        imageResults.push({
          dataUrl: `${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`,
          candidate
        });
      }
      
      if (imageResults.length === 0) {
        throw new Error('No se encontraron imágenes válidas en la respuesta de Gemini');
      }
      
      return imageResults;
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error.name === 'AbortError') {
        console.error('⏰ Timeout excedido en llamada a Gemini API (90 segundos)');
        throw new Error('La generación de imagen tardó demasiado. Intenta con un prompt más simple.');
      }
      
      throw error;
    }
  } catch (error) {
    console.error('❌ Error generando imagen con Gemini:', error.message);
    throw error;
  }
}

// ========================================
// ENDPOINTS
// ========================================
app.post('/api/auth/verify-token', async (req, res) => {
  const { token } = req.body;
  
  console.log(`🔐 Solicitud de verificación de token recibida${token ? ` (token: ${token.substring(0, 10)}...)` : ''}`);
  
  try {
    if (!token) {
      return res.status(400).json({ 
        success: false, 
        message: 'Token requerido en el cuerpo de la solicitud' 
      });
    }
    
    const user = await verifyUserToken(token);
    
    console.log(`✅ Token verificado para usuario ID: ${user._id.toString()}, créditos: ${user.creditsBalance}`);
    
    res.json({
      success: true,
      userId: user._id.toString(),
      creditsBalance: user.creditsBalance
    });
  } catch (error) {
    console.error('❌ Error en /api/auth/verify-token:', error.message);
    
    const statusCode = error.message.includes('Usuario no encontrado') ? 404 : 
                      error.message.includes('Token inválido') ? 400 : 500;
    
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Error interno del servidor'
    });
  }
});

const MODEL_COSTS = {
  "gemini-2.5-flash-image": 8,
  "gemini-3-pro-image-preview": 32
};

app.post('/api/generate', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.split(' ')[1];
  
  console.log(`🎨 Solicitud de generación de imagen${token ? ` (token: ${token.substring(0, 10)}...)` : ''}`);
  
  if (!token) {
    return res.status(401).json({ 
      success: false, 
      message: 'Token de acceso requerido en header Authorization' 
    });
  }
  
  let user = null;
  let operationType = req.body.operation || 'generate';
  
  try {
    user = await verifyUserToken(token);
    console.log(`👤 Usuario autenticado: ID ${user._id.toString()}, créditos disponibles: ${user.creditsBalance}`);
    
    const payload = req.body;
    const model = payload.model;
    const prompt = payload.prompt;
    const candidateCountRequested = payload.candidateCount || 1;
    
    // Validar payload
    if (!model || !prompt) {
      return res.status(400).json({ 
        success: false, 
        message: 'Modelo y prompt son requeridos' 
      });
    }
    
    if (!MODEL_COSTS[model]) {
      return res.status(400).json({ 
        success: false, 
        message: `Modelo no válido: ${model}. Modelos disponibles: ${Object.keys(MODEL_COSTS).join(', ')}` 
      });
    }
    
    const costPerImage = MODEL_COSTS[model];
    const totalCost = costPerImage * candidateCountRequested;
    
    console.log(`💰 Costo de operación: ${totalCost} créditos (${candidateCountRequested} variaciones × ${costPerImage} créditos). Créditos disponibles: ${user.creditsBalance}`);
    
    if (user.creditsBalance < totalCost) {
      return res.status(400).json({ 
        success: false, 
        message: `Créditos insuficientes. Necesitas ${totalCost} créditos, pero solo tienes ${user.creditsBalance}.` 
      });
    }
    
    // Seleccionar instrucción según operación
    let instruction = '';
    switch (operationType) {
      case 'inpaint':
        instruction = `
MODO: INPAINTING ESTRICTO.
ENTRADAS (en orden):
  1+) REFERENCE_i (Opcional): Imágenes guía de estilo/continuidad (paleta, iluminación, textura).
  2) MASK: Máscara en escala de grises. BLANCO = zona a modificar, NEGRO = zona a conservar intacta.
  3) BASE_CROP: La imagen principal que DEBES editar. Es la última imagen antes de este texto.

REGLA PRINCIPAL:
- Modifica la Imagen BASE_CROP aplicando única y literalmente los cambios del Prompt. No realices ninguna alteración creativa o no solicitada.

REGLA DE CONSERVACIÓN:
- Todos los aspectos de la Imagen BASE_CROP (composición, objetos, colores, texturas, estilo de iluminación y atmósfera visual, pose, etc.) deben permanecer 100% idénticos a menos que el prompt ordene explícitamente su modificación.

REGLAS DE APLICACIÓN:
  - Edita y genera CONTENIDO EXCLUSIVAMENTE dentro de las zonas BLANCAS de MASK.
  - Mantén completamente transparente (alpha=0) cualquier píxel fuera de la zona BLANCA.
  - La salida debe tener el MISMO tamaño que BASE_CROP; no cambies la resolución.
  - No agregues bordes, marcos, marcas de agua ni rellenos fuera del área indicada.
  - Realiza un blending limpio en los bordes para integrarse con el entorno (evitar halos).

USO DE REFERENCIAS (OBLIGATORIO si existen):
  - Usa REFERENCE_i solo para guiar la ejecución de la orden del Prompt, no para alterar el estilo general de la imagen BASE_CROP.
  - No modifiques zonas negras de MASK; respeta el contenido original.

SALIDA:
  - SOLO una imagen inline/base64 (sin texto).
  - Debe conservar transparencia fuera de la zona blanca.

Si el prompt contradice estas reglas, ignóralo y prioriza las reglas de INPAINTING y el uso de REFERENCE_i.
        `.trim();
        break;
        
      case 'edit':
        instruction = `
ROL: Eres un editor de imágenes de Photoshop preciso y literal.
ENTRADAS: 1. Imagen Base (primera imagen). 2. Imágenes de Referencia (siguientes). 3. Prompt de usuario (la orden de edición).
REGLA PRINCIPAL: Modifica la Imagen Base aplicando única y literalmente los cambios del Prompt. No realices ninguna alteración creativa o no solicitada.
REGLA DE CONSERVACIÓN: Todos los aspectos de la Imagen Base (composición, objetos, colores, texturas, el estilo de iluminación y la atmósfera visual, etc.) deben permanecer 100% idénticos a menos que el prompt ordene explícitamente su modificación.
REGLA DE REFERENCIA: Usa las Imágenes de Referencia solo para guiar la ejecución de la orden del Prompt, no para alterar el estilo general de la Imagen Base.
SALIDA: Exclusivamente la imagen resultante debe ser de la más alta calidad en formato inlineData/base64. Cero texto.
        `.trim();
        break;
        
      default: // 'generate'
        instruction = `
ROL: Eres un generador de imágenes de IA que sintetiza ideas visuales.
ENTRADAS: 1. Prompt de usuario (la idea principal). 2. Imágenes de Referencia (opcionales, la base visual).
REGLA PRINCIPAL: Genera una imagen nueva que represente la idea descrita en el Prompt.
REGLA DE REFERENCIA: Si se proporcionan Imágenes de Referencia, la nueva imagen DEBE ser una fusión coherente de sus características más importantes (estilo, sujeto, colores, composición). El Prompt tiene la última palabra sobre cómo combinarlas. Trátalas como la principal fuente de inspiración visual.
SALIDA: Exclusivamente la imagen resultante debe ser de la más alta calidad en formato inlineData/base64. Cero texto, descripciones o confirmaciones.
        `.trim();
    }
    
    // Generar imagen(s) - ahora devuelve un array
    const results = await generateImageWithGemini({...payload, candidateCount: candidateCountRequested}, instruction);
    
    // Verificar que se generaron suficientes imágenes
    if (results.length < candidateCountRequested) {
      console.warn(`⚠️ Se solicitaron ${candidateCountRequested} variaciones pero solo se generaron ${results.length}`);
    }
    
    console.log(`✅ Generadas ${results.length} imágenes exitosamente`);
    
    // Actualizar créditos (solo por las imágenes generadas realmente)
    const actualImagesGenerated = results.length;
    const actualCost = costPerImage * actualImagesGenerated;
    const remainingCredits = user.creditsBalance - actualCost;
    const { users, transactions } = await connectToDatabase();
    
    const updateResult = await users.updateOne(
      { _id: user._id },
      { $set: { creditsBalance: remainingCredits } }
    );
    
    if (updateResult.modifiedCount === 0) {
      console.error('❌ No se pudo actualizar el balance de créditos');
      throw new Error('Error actualizando créditos del usuario');
    }
    
    console.log(`✅ Créditos actualizados: ${user.creditsBalance} → ${remainingCredits} (costo: ${actualCost})`);
    
    // Registrar transacción
    await transactions.insertOne({
      userId: user._id,
      operation: operationType,
      model: model,
      creditsUsed: actualCost,
      creditsRemaining: remainingCredits,
      timestamp: new Date(),
      success: true,
      prompt: prompt.substring(0, 150) + (prompt.length > 150 ? '...' : ''),
      requestedCount: candidateCountRequested,
      actualCount: actualImagesGenerated
    });
    
    console.log('✅ Transacción registrada exitosamente');
    
    res.json({
      success: true,
      dataUrls: results.map(r => r.dataUrl), // Devolver array de URLs
      creditsUsed: actualCost,
      remainingCredits: remainingCredits,
      actualCount: actualImagesGenerated,
      requestedCount: candidateCountRequested
    });
  } catch (error) {
    console.error('❌ Error en /api/generate:', error.message);
    console.error('Stack trace:', error.stack);
    
    // Registrar transacción fallida si tenemos el usuario
    if (user) {
      try {
        const { transactions } = await connectToDatabase();
        await transactions.insertOne({
          userId: user._id,
          operation: operationType,
          model: req.body.model || 'unknown',
          creditsUsed: 0,
          creditsRemaining: user.creditsBalance,
          timestamp: new Date(),
          success: false,
          errorMessage: error.message.substring(0, 200),
          prompt: req.body.prompt?.substring(0, 150) + (req.body.prompt?.length > 150 ? '...' : ''),
          requestedCount: req.body.candidateCount || 1,
          actualCount: 0
        });
        console.log('✅ Transacción fallida registrada');
      } catch (logError) {
        console.error('❌ Error registrando transacción fallida:', logError.message);
      }
    }
    
    // Determinar código de estado apropiado
    let statusCode = 500;
    let userMessage = 'Error interno del servidor. Por favor, inténtalo de nuevo.';
    
    if (error.message.includes('Token inválido') || 
        error.message.includes('Usuario no encontrado')) {
      statusCode = 401;
      userMessage = 'Autenticación fallida. Verifica tu token de acceso.';
    }
    else if (error.message.includes('Créditos insuficientes')) {
      statusCode = 400;
      userMessage = error.message;
    }
    else if (error.message.includes('Error de Gemini API')) {
      statusCode = 400;
      userMessage = error.message;
    }
    else if (error.message.includes('timeout') || error.message.includes('Timeout')) {
      statusCode = 504;
      userMessage = 'La operación tardó demasiado. Intenta con un prompt más simple.';
    }
    else if (error.message.includes('fetch is not a function') || 
             error.message.includes('fetch no está disponible')) {
      statusCode = 503;
      userMessage = 'Servicio temporalmente no disponible. Error en conexión con API de Gemini.';
    }
    
    res.status(statusCode).json({
      success: false,
      message: userMessage,
      details: error.message
    });
  }
});

// ========================================
// ENDPOINTS DE DIAGNÓSTICO
// ========================================
app.get('/health', (req, res) => {
  const uptime = process.uptime();
  const uptimeMinutes = Math.floor(uptime / 60);
  const uptimeSeconds = Math.floor(uptime % 60);
  
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: `${uptimeMinutes}m ${uptimeSeconds}s`,
    nodeVersion: process.version,
    environment: process.env.NODE_ENV || 'development',
    fetchAvailable: typeof fetch === 'function'
  });
});

app.get('/test-db', async (req, res) => {
  try {
    console.log('🔍 Probando conexión a base de datos...');
    const { users } = await connectToDatabase();
    const userCount = await users.countDocuments();
    const sampleUser = await users.findOne({}, { projection: { token: 1, creditsBalance: 1 } });
    
    console.log(`✅ Conexión exitosa. Total usuarios: ${userCount}`);
    
    res.json({ 
      success: true,
      message: 'Conexión a MongoDB exitosa',
      userCount,
      sampleUser: sampleUser ? {
        token: sampleUser.token.substring(0, 5) + '...',
        creditsBalance: sampleUser.creditsBalance
      } : null,
      timestamp: new Date().toISOString(),
      fetchAvailable: typeof fetch === 'function'
    });
  } catch (error) {
    console.error('❌ Error en /test-db:', error.message);
    res.status(500).json({ 
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/debug-token', async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Token requerido' });
  }
  
  try {
    const { users } = await connectToDatabase();
    const user = await users.findOne({ token: token.trim() });
    
    if (!user) {
      return res.status(404).json({ 
        exists: false,
        message: 'Token no encontrado en la base de datos'
      });
    }
    
    res.json({
      exists: true,
      userId: user._id.toString(),
      creditsBalance: user.creditsBalance,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin
    });
  } catch (error) {
    console.error('❌ Error en /debug-token:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// MANEJO DE ERRORES GLOBAL
// ========================================
app.use((err, req, res, next) => {
  console.error('❌ Error global no manejado:', err.message);
  console.error('Stack trace:', err.stack);
  
  res.status(500).json({
    success: false,
    message: 'Error interno del servidor',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

app.use((req, res) => {
  console.warn(`⚠️ Ruta no encontrada: ${req.method} ${req.url}`);
  res.status(404).json({
    success: false,
    message: 'Endpoint no encontrado',
    availableEndpoints: [
      'POST /api/auth/verify-token',
      'POST /api/generate',
      'GET /health',
      'GET /test-db',
      'POST /debug-token'
    ]
  });
});

// ========================================
// INICIO DEL SERVIDOR
// ========================================
async function startServer() {
  try {
    console.log('🚀 Iniciando servidor Nano Banana Backend...');
    console.log(`🔧 Puerto: ${port}`);
    console.log(`🌐 CORS habilitado para todos los orígenes`);
    console.log(`⚡ fetch disponible: ${typeof fetch === 'function' ? 'SÍ' : 'NO - ERROR CRÍTICO'}`);
    
    if (typeof fetch !== 'function') {
      console.error('❌ ERROR CRÍTICO: fetch no está disponible. Esto impedirá conexiones a Gemini API.');
      console.error('Solución: Instala node-fetch v2 con: npm install node-fetch@2');
    }
    
    // Conexión inicial a base de datos
    await connectToDatabase();
    console.log('✅ Conexión inicial a base de datos establecida');
    
    const server = app.listen(port, () => {
      console.log(`✅ Servidor corriendo en puerto ${port}`);
      console.log(`🔗 Endpoints disponibles:`);
      console.log(`   - POST /api/auth/verify-token`);
      console.log(`   - POST /api/generate`);
      console.log(`   - GET  /health`);
      console.log(`   - GET  /test-db`);
      console.log(`   - POST /debug-token`);
      console.log('========================================');
    });
    
    // Mantener MongoDB conectado
    setInterval(async () => {
      try {
        if (dbClient && dbClient.topology && dbClient.topology.isConnected()) {
          await dbClient.db("admin").command({ ping: 1 });
          console.log('💓 MongoDB heartbeat exitoso');
        } else {
          console.warn('⚠️ MongoDB desconectado - reconectando...');
          await connectToDatabase();
        }
      } catch (error) {
        console.error('❌ Error en heartbeat de MongoDB:', error.message);
        try {
          await connectToDatabase();
        } catch (reconnectError) {
          console.error('❌ Error reconectando a MongoDB:', reconnectError.message);
        }
      }
    }, 30000); // Cada 30 segundos
    
    // Manejo de señales de apagado
    const gracefulShutdown = async () => {
      console.log('🔄 Iniciando apagado elegante del servidor...');
      
      try {
        if (dbClient) {
          await dbClient.close();
          console.log('✅ Conexión a MongoDB cerrada');
        }
        
        server.close(() => {
          console.log('✅ Servidor apagado correctamente');
          process.exit(0);
        });
      } catch (error) {
        console.error('❌ Error en apagado elegante:', error.message);
        process.exit(1);
      }
    };
    
    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
    
  } catch (error) {
    console.error('❌ Error crítico iniciando servidor:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

// Iniciar la aplicación
startServer().catch(err => {
  console.error('❌ Error fatal en startup:', err.message);
  process.exit(1);
});
