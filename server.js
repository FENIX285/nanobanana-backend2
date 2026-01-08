require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion } = require('mongodb');
const fetch = require('node-fetch');
const app = express();
const port = process.env.PORT || 3000;

// Verificar variables de entorno críticas al inicio
const requiredEnvVars = ['MONGODB_URI', 'GEMINI_API_KEY'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error(`❌ ERROR CRÍTICO: Variables de entorno faltantes: ${missingVars.join(', ')}`);
  console.error('Por favor, configura estas variables en Railway antes de desplegar.');
  process.exit(1);
}

console.log('✅ Variables de entorno verificadas correctamente');

// Configurar CORS para aceptar solicitudes desde el plugin de Photoshop
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));

// Conexión a MongoDB Atlas
const uri = process.env.MONGODB_URI;
let client;
let dbConnection = null;

async function connectToDatabase() {
  try {
    if (dbConnection) return dbConnection;
    
    console.log('🔍 Intentando conectar a MongoDB Atlas...');
    
    client = new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
      serverSelectionTimeoutMS: 5000, // 5 segundos de timeout
      connectTimeoutMS: 10000,        // 10 segundos de timeout
      socketTimeoutMS: 45000,         // 45 segundos de timeout
      heartbeatFrequencyMS: 10000,    // 10 segundos entre heartbeats
    });

    await client.connect();
    
    // Verificar conexión
    await client.db("admin").command({ ping: 1 });
    console.log("✅ Conexión exitosa a MongoDB Atlas");
    
    const db = client.db("nano_banana");
    const usersCollection = db.collection("users");
    const transactionsCollection = db.collection("transactions");
    
    // Crear índices
    await Promise.all([
      usersCollection.createIndex({ token: 1 }, { unique: true, background: true }),
      usersCollection.createIndex({ createdAt: 1 }, { background: true }),
      transactionsCollection.createIndex({ userId: 1 }, { background: true }),
      transactionsCollection.createIndex({ timestamp: 1 }, { background: true })
    ]);
    
    console.log("✅ Índices creados/verificados");
    
    dbConnection = {
      users: usersCollection,
      transactions: transactionsCollection
    };
    
    return dbConnection;
  } catch (error) {
    console.error("❌ Error crítico conectando a MongoDB:", error.message);
    console.error("Stack trace:", error.stack);
    
    // Intentar cerrar cliente si existe
    if (client) {
      try {
        await client.close();
      } catch (closeError) {
        console.error("Error cerrando cliente MongoDB:", closeError.message);
      }
    }
    
    client = null;
    dbConnection = null;
    
    // Lanzar error para que sea manejado por el caller
    throw new Error(`Error de conexión a base de datos: ${error.message}`);
  }
}

// Función para obtener colecciones con reconexión automática
async function getDbCollections() {
  try {
    if (!dbConnection) {
      dbConnection = await connectToDatabase();
    }
    return dbConnection;
  } catch (error) {
    console.error("❌ Error obteniendo colecciones:", error.message);
    throw error;
  }
}

// Función para verificar token simple contra MongoDB
async function verifyUserToken(token) {
  if (!token || typeof token !== 'string' || token.trim() === '') {
    throw new Error('Token inválido o vacío');
  }
  
  try {
    const { users } = await getDbCollections();
    const user = await users.findOne({ token: token.trim() });
    
    if (!user) {
      throw new Error('Usuario no encontrado');
    }
    
    // Actualizar última conexión
    await users.updateOne(
      { _id: user._id },
      { $set: { lastLogin: new Date() } }
    );
    
    return user;
  } catch (error) {
    console.error("❌ Error en verifyUserToken:", error.message);
    throw error;
  }
}

// Ruta para verificar token y obtener créditos
app.post('/api/auth/verify-token', async (req, res) => {
  const { token } = req.body;
  
  console.log(`🔍 Solicitud de verificación de token recibida: ${token ? token.substring(0, 10) + '...' : 'TOKEN VACÍO'}`);
  
  try {
    if (!token) {
      console.warn('⚠️ Solicitud sin token');
      return res.status(400).json({ 
        success: false,
        message: 'Token requerido en el cuerpo de la solicitud' 
      });
    }
    
    const user = await verifyUserToken(token);
    
    console.log(`✅ Token verificado exitosamente para usuario ID: ${user._id.toString()}`);
    
    res.json({
      success: true,
      userId: user._id.toString(),
      creditsBalance: user.creditsBalance
    });
  } catch (error) {
    console.error("❌ Error verificando token:", error.message);
    
    // Clasificar errores para respuestas más específicas
    if (error.message.includes('Token inválido') || error.message.includes('vacío')) {
      return res.status(400).json({ 
        success: false,
        message: 'Token inválido o mal formateado' 
      });
    }
    
    if (error.message.includes('Usuario no encontrado')) {
      return res.status(404).json({ 
        success: false,
        message: 'Token no reconocido. Verifica que el token sea correcto.' 
      });
    }
    
    if (error.message.includes('Error de conexión a base de datos')) {
      return res.status(503).json({ 
        success: false,
        message: 'Servicio temporalmente no disponible. Inténtalo de nuevo en unos minutos.' 
      });
    }
    
    // Error genérico
    res.status(500).json({ 
      success: false,
      message: 'Error interno del servidor. Por favor, contacta al administrador.' 
    });
  }
});

// Función para generar imagen usando Gemini API
async function generateImageWithGemini(payload, instruction) {
  try {
    const { model, prompt, operation, referenceImages, baseImage, maskImage, aspectRatio, resolution } = payload;
    
    // Preparar las partes del contenido según el tipo de operación
    const parts = [];
    
    // Añadir instrucciones forzadas primero
    parts.push({ text: instruction });
    
    // Añadir imágenes de referencia con captions
    if (referenceImages && referenceImages.length > 0) {
      for (let i = 0; i < referenceImages.length; i++) {
        const ref = referenceImages[i];
        const idx = i + 1;
        parts.push({
          text: `REFERENCE_${idx}: guía SOLO de estilo/continuidad. Usa su paleta de color, iluminación y textura, pero NO copies su geometría ni encuadre 1:1.`
        });
        parts.push({
          inline_data: {  // CORREGIDO: inline_data en lugar de inline_
            mime_type: ref.mimeType,
            data: ref.data
          }
        });
      }
    }
    
    // Para operaciones de inpainting
    if (operation === 'inpaint' && maskImage && baseImage) {
      // Añadir máscara
      parts.push({
        text: "MASK: Define el área a modificar. BLANCO = zona a modificar, NEGRO = zona a conservar intacta."
      });
      parts.push({
        inline_data: {  // CORREGIDO: inline_data en lugar de inline_
          mime_type: maskImage.mimeType,
          data: maskImage.data
        }
      });
      
      // Añadir imagen base a editar
      parts.push({
        text: "BASE_CROP: La imagen principal que DEBES editar. Es la última imagen antes de este texto."
      });
      parts.push({
        inline_data: {  // CORREGIDO: inline_data en lugar de inline_
          mime_type: baseImage.mimeType,
          data: baseImage.data
        }
      });
    } 
    // Para operaciones de edición sin selección
    else if (operation === 'edit' && baseImage) {
      parts.push({
        text: "BASE_IMAGE: imagen a editar sin selección activa."
      });
      parts.push({
        inline_data: {  // CORREGIDO: inline_data en lugar de inline_
          mime_type: baseImage.mimeType,
          data: baseImage.data
        }
      });
    }
    
    // Añadir el prompt del usuario
    parts.push({
      text: `PROMPT_USUARIO:\n${prompt}`
    });
    
    // Configuración de generación
    const genConfig = {
      responseModalities: ["IMAGE"],
      candidateCount: 1
    };
    
    // Configuración específica por modelo
    if (model === "gemini-2.5-flash-image") {
      if (aspectRatio) {
        genConfig.imageConfig = { aspectRatio };
      }
    } else if (model === "gemini-3-pro-image-preview") {
      const imgCfg = {};
      if (aspectRatio) imgCfg.aspectRatio = aspectRatio;
      if (resolution) imgCfg.imageSize = resolution;
      if (Object.keys(imgCfg).length > 0) {
        genConfig.imageConfig = imgCfg;
      }
    }
    
    console.log(`🚀 Llamando a Gemini API con modelo: ${model}, operación: ${operation}`);
    
    // Llamar a la API de Gemini con timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 segundos de timeout
    
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: genConfig
          }),
          signal: controller.signal
        }
      );
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.error?.message || `Error ${response.status}: ${response.statusText}`;
        console.error(`❌ Error de Gemini API: ${errorMessage}`);
        throw new Error(`Error de Gemini API: ${errorMessage}`);
      }
      
      const data = await response.json();
      console.log('✅ Respuesta recibida de Gemini API');
      
      const candidate = data.candidates?.[0];
      
      if (!candidate) {
        throw new Error('No se obtuvo candidato de la respuesta');
      }
      
      if (candidate.finishReason === 'IMAGE_SAFETY') {
        console.warn('⚠️ Imagen rechazada por motivos de seguridad');
        throw new Error('La imagen fue rechazada por motivos de seguridad. Intenta con un prompt diferente.');
      }
      
      const imagePart = candidate.content?.parts?.find(p => p.inlineData?.data);
      if (!imagePart) {
        throw new Error('No se encontró imagen en la respuesta');
      }
      
      return {
        dataUrl: `${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`,
        raw: candidate
      };
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  } catch (error) {
    console.error("❌ Error generando imagen con Gemini:", error.message);
    throw error;
  }
}

// Ruta para generar/editar imágenes
app.post('/api/generate', async (req, res) => {
  // Obtener token del header de autorización
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  console.log(`📝 Solicitud de generación recibida. Token: ${token ? token.substring(0, 10) + '...' : 'NO PROPORCIONADO'}`);
  
  if (!token) {
    console.warn('❌ Solicitud sin token de autorización');
    return res.status(401).json({ 
      success: false,
      message: 'Token de acceso requerido en header Authorization' 
    });
  }
  
  let user = null;
  let operationType = req.body.operation || 'generate';
  
  try {
    // Verificar token contra MongoDB
    user = await verifyUserToken(token);
    console.log(`✅ Usuario autenticado: ID ${user._id.toString()}, créditos: ${user.creditsBalance}`);
    
    const payload = req.body;
    
    // Validar payload
    if (!payload.model || !payload.prompt) {
      console.warn('❌ Payload incompleto: faltan modelo o prompt');
      return res.status(400).json({ 
        success: false,
        message: 'Modelo y prompt son requeridos en el cuerpo de la solicitud' 
      });
    }
    
    const costPerImage = MODEL_COSTS[payload.model] || 8;
    const totalCost = costPerImage;
    
    console.log(`💰 Costo de operación: ${totalCost} créditos. Créditos disponibles: ${user.creditsBalance}`);
    
    // Verificar créditos suficientes
    if (user.creditsBalance < totalCost) {
      console.warn(`❌ Créditos insuficientes para usuario ${user._id.toString()}`);
      return res.status(400).json({ 
        success: false,
        message: `Créditos insuficientes. Se necesitan ${totalCost} créditos, pero solo tienes ${user.creditsBalance}.` 
      });
    }
    
    let result;
    let instruction = '';
    
    // Seleccionar instrucción según operación
    switch (payload.operation) {
      case 'inpaint':
        instruction = [
          "MODO: INPAINTING ESTRICTO.",
          "ENTRADAS (en orden):",
          "  1+) REFERENCE_i (Opcional): Imágenes guía de estilo/continuidad (paleta, iluminación, textura).",
          "  2) MASK: Máscara en escala de grises. BLANCO = zona a modificar, NEGRO = zona a conservar intacta.",
          "  3) BASE_CROP: La imagen principal que DEBES editar. Es la última imagen antes de este texto.",
          "",
          "REGLA PRINCIPAL:",
          "- Modifica la Imagen BASE_CROP aplicando única y literalmente los cambios del Prompt. No realices ninguna alteración creativa o no solicitada.",
          "",
          "REGLA DE CONSERVACIÓN:",
          "- Todos los aspectos de la Imagen BASE_CROP (composición, objetos, colores, texturas, estilo de iluminación y atmósfera visual, pose, etc.) deben permanecer 100% idénticos a menos que el prompt ordene explícitamente su modificación.",
          "",
          "REGLAS DE APLICACIÓN:",
          "  - Edita y genera CONTENIDO EXCLUSIVAMENTE dentro de las zonas BLANCAS de MASK.",
          "  - Mantén completamente transparente (alpha=0) cualquier píxel fuera de la zona BLANCA.",
          "  - La salida debe tener el MISMO tamaño que BASE_CROP; no cambies la resolución.",
          "  - No agregues bordes, marcos, marcas de agua ni rellenos fuera del área indicada.",
          "  - Realiza un blending limpio en los bordes para integrarse con el entorno (evitar halos).",
          "",
          "USO DE REFERENCIAS (OBLIGATORIO si existen):",
          "  - Usa REFERENCE_i solo para guiar la ejecución de la orden del Prompt, no para alterar el estilo general de la imagen BASE_CROP.",
          "  - No modifiques zonas negras de MASK; respeta el contenido original.",
          "",
          "SALIDA:",
          "  - SOLO una imagen inline/base64 (sin texto).",
          "  - Debe conservar transparencia fuera de la zona blanca.",
          "",
          "Si el prompt contradice estas reglas, ignóralo y prioriza las reglas de INPAINTING y el uso de REFERENCE_i."
        ].join("\n");
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
    
    console.log(`🎨 Generando imagen con instrucción para: ${operationType}`);
    
    // Generar imagen
    result = await generateImageWithGemini(payload, instruction);
    
    console.log('✅ Imagen generada exitosamente');
    
    // Deduct credits and update user
    const remainingCredits = user.creditsBalance - totalCost;
    const { users, transactions } = await getDbCollections();
    
    const updateResult = await users.updateOne(
      { _id: user._id },
      { $set: { creditsBalance: remainingCredits } }
    );
    
    if (updateResult.modifiedCount === 0) {
      console.error('❌ No se pudo actualizar el balance de créditos del usuario');
      throw new Error('Error actualizando créditos del usuario');
    }
    
    console.log(`✅ Créditos deducidos: ${totalCost}. Nuevo balance: ${remainingCredits}`);
    
    // Register transaction
    await transactions.insertOne({
      userId: user._id,
      operation: payload.operation,
      model: payload.model,
      creditsUsed: totalCost,
      creditsRemaining: remainingCredits,
      timestamp: new Date(),
      success: true,
      prompt: payload.prompt.substring(0, 100) + (payload.prompt.length > 100 ? '...' : '') // Guardar primeros 100 caracteres del prompt
    });
    
    console.log('✅ Transacción registrada exitosamente');
    
    res.json({
      success: true,
      dataUrl: result.dataUrl,
      creditsUsed: totalCost,
      remainingCredits: remainingCredits
    });
  } catch (error) {
    console.error("❌ Error en generación de imagen:", error.message);
    console.error("Stack trace:", error.stack);
    
    // Registrar transacción fallida si tenemos el usuario
    if (user) {
      try {
        const { transactions } = await getDbCollections();
        await transactions.insertOne({
          userId: user._id,
          operation: operationType,
          model: req.body.model || 'unknown',
          creditsUsed: 0,
          creditsRemaining: user.creditsBalance,
          timestamp: new Date(),
          success: false,
          errorMessage: error.message.substring(0, 200),
          prompt: req.body.prompt ? req.body.prompt.substring(0, 100) + (req.body.prompt.length > 100 ? '...' : '') : null
        });
        console.log('✅ Transacción fallida registrada');
      } catch (logError) {
        console.error('❌ Error registrando transacción fallida:', logError.message);
      }
    }
    
    // Clasificar errores para respuestas más específicas
    if (error.message.includes('Token inválido') || 
        error.message.includes('Usuario no encontrado') || 
        error.message.includes('Token requerido')) {
      return res.status(401).json({ 
        success: false,
        message: 'Autenticación fallida. Por favor, verifica tu token.' 
      });
    }
    
    if (error.message.includes('Créditos insuficientes')) {
      return res.status(400).json({ 
        success: false,
        message: error.message 
      });
    }
    
    if (error.message.includes('Error de conexión a base de datos') || 
        error.message.includes('Application failed to respond')) {
      return res.status(503).json({ 
        success: false,
        message: 'Servicio temporalmente no disponible. Inténtalo de nuevo en unos minutos.' 
      });
    }
    
    if (error.message.includes('Error de Gemini API') || 
        error.message.includes('seguridad') || 
        error.message.includes('No se encontró imagen')) {
      return res.status(400).json({ 
        success: false,
        message: 'Error generando imagen: ' + error.message 
      });
    }
    
    // Error genérico
    res.status(500).json({ 
      success: false,
      message: 'Error interno del servidor. Por favor, contacta al administrador.' 
    });
  }
});

// Ruta de salud para Railway
app.get('/health', (req, res) => {
  const uptime = process.uptime();
  const uptimeMinutes = Math.floor(uptime / 60);
  const uptimeSeconds = Math.floor(uptime % 60);
  
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: `${uptimeMinutes}m ${uptimeSeconds}s`,
    environment: process.env.NODE_ENV || 'development'
  });
});

// Endpoint para probar la conexión
app.get('/test', async (req, res) => {
  try {
    console.log('🔍 Probando conexión a MongoDB...');
    const { users } = await getDbCollections();
    const userCount = await users.countDocuments();
    console.log(`✅ Conexión exitosa. Usuarios en base de datos: ${userCount}`);
    
    res.json({ 
      message: 'Conexión a MongoDB exitosa',
      userCount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error en endpoint /test:', error.message);
    res.status(500).json({ 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Middleware de manejo de errores global
app.use((err, req, res, next) => {
  console.error('❌ Error global no manejado:', err.message);
  console.error('Stack trace:', err.stack);
  
  res.status(500).json({
    success: false,
    message: 'Error interno del servidor',
    timestamp: new Date().toISOString()
  });
});

// Manejar rutas no encontradas
app.use((req, res) => {
  console.warn(`⚠️ Ruta no encontrada: ${req.method} ${req.url}`);
  res.status(404).json({
    success: false,
    message: 'Endpoint no encontrado',
    timestamp: new Date().toISOString()
  });
});

// Iniciar servidor
async function startServer() {
  try {
    console.log('🚀 Iniciando servidor...');
    console.log(`🔧 Puerto: ${port}`);
    console.log(`🔗 MongoDB URI: ${uri.replace(/\/\/(.*?):(.*?)@/, '//[USER]:[PASSWORD]@')}`);
    
    // Probar conexión a MongoDB antes de iniciar el servidor
    await connectToDatabase();
    
    const server = app.listen(port, () => {
      console.log(`✅ Servidor corriendo en puerto ${port}`);
      console.log(`🔗 URL pública: http://localhost:${port} (en producción será tu URL de Railway)`);
      console.log('========================================');
    });
    
    // Mantener MongoDB conectado con heartbeats
    setInterval(async () => {
      try {
        if (client && client.topology && client.topology.isConnected()) {
          await client.db("admin").command({ ping: 1 });
          console.log("💓 MongoDB heartbeat exitoso - conexión activa");
        } else {
          console.warn("⚠️ MongoDB desconectado - intentando reconectar...");
          await connectToDatabase();
        }
      } catch (error) {
        console.error("❌ Error en heartbeat de MongoDB:", error.message);
        try {
          // Intentar reconectar
          await connectToDatabase();
        } catch (reconnectError) {
          console.error("❌ Error reconectando a MongoDB:", reconnectError.message);
        }
      }
    }, 60000); // Cada minuto
    
    // Manejar cierre elegante
    const gracefulShutdown = async () => {
      console.log('🔄 Iniciando apagado elegante del servidor...');
      
      try {
        // Dejar de aceptar nuevas conexiones
        server.close(async (err) => {
          if (err) {
            console.error('❌ Error cerrando servidor:', err.message);
            process.exit(1);
          }
          
          // Cerrar conexión a MongoDB
          if (client) {
            await client.close();
            console.log('✅ Conexión a MongoDB cerrada');
          }
          
          console.log('✅ Servidor apagado correctamente');
          process.exit(0);
        });
        
        // Forzar cierre después de 10 segundos
        setTimeout(() => {
          console.error('⏰ Timeout en apagado elegante - forzando cierre');
          process.exit(1);
        }, 10000);
      } catch (error) {
        console.error('❌ Error en apagado elegante:', error.message);
        process.exit(1);
      }
    };
    
    // Escuchar señales de apagado
    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGQUIT', gracefulShutdown);
    
  } catch (error) {
    console.error("❌ Error crítico iniciando servidor:", error.message);
    console.error("Stack trace:", error.stack);
    process.exit(1);
  }
}

// Iniciar la aplicación
startServer().catch(err => {
  console.error("❌ Error fatal en startServer:", err.message);
  process.exit(1);
});

console.log('Intialized server startup process...');
