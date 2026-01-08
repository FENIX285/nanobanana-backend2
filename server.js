require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion } = require('mongodb');
const fetch = require('node-fetch');
const app = express();
const port = process.env.PORT || 3000;

// Configurar CORS para aceptar solicitudes desde el plugin de Photoshop
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));

// Conexión a MongoDB Atlas
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

// Colecciones
let usersCollection;
let transactionsCollection;

// Costos por modelo
const MODEL_COSTS = {
  "gemini-2.5-flash-image": 8,
  "gemini-3-pro-image-preview": 32
};

// Conectar a MongoDB
async function connectToDatabase() {
  try {
    await client.connect();
    const db = client.db("nano_banana");
    usersCollection = db.collection("users");
    transactionsCollection = db.collection("transactions");
    
    // Crear índices
    await usersCollection.createIndex({ token: 1 }, { unique: true });
    await usersCollection.createIndex({ createdAt: 1 });
    await transactionsCollection.createIndex({ userId: 1 });
    await transactionsCollection.createIndex({ timestamp: 1 });
    
    console.log("Conectado a MongoDB Atlas");
  } catch (error) {
    console.error("Error conectando a MongoDB:", error);
    process.exit(1);
  }
}

// Función para verificar token simple contra MongoDB
async function verifyUserToken(token) {
  if (!token || typeof token !== 'string' || token.trim() === '') {
    throw new Error('Token inválido o vacío');
  }
  
  const user = await usersCollection.findOne({ token: token.trim() });
  if (!user) {
    throw new Error('Usuario no encontrado');
  }
  
  return user;
}

// Ruta para verificar token y obtener créditos
app.post('/api/auth/verify-token', async (req, res) => {
  const { token } = req.body;
  
  try {
    const user = await verifyUserToken(token);
    res.json({
      success: true,
      userId: user._id.toString(),
      creditsBalance: user.creditsBalance
    });
  } catch (error) {
    console.error("Error verificando token:", error);
    res.status(401).json({ 
      success: false,
      message: error.message || 'Token inválido' 
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
          inline_ {
            mime_type: ref.mimeType,
             ref.data
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
        inline_ {
          mime_type: maskImage.mimeType,
           maskImage.data
        }
      });
      
      // Añadir imagen base a editar
      parts.push({
        text: "BASE_CROP: La imagen principal que DEBES editar. Es la última imagen antes de este texto."
      });
      parts.push({
        inline_data: {
          mime_type: baseImage.mimeType,
           baseImage.data
        }
      });
    } 
    // Para operaciones de edición sin selección
    else if (operation === 'edit' && baseImage) {
      parts.push({
        text: "BASE_IMAGE: imagen a editar sin selección activa."
      });
      parts.push({
        inline_ {
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
    
    // Llamar a la API de Gemini
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
        })
      }
    );
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Error de Gemini API: ${errorData.error?.message || response.statusText}`);
    }
    
    const data = await response.json();
    const candidate = data.candidates?.[0];
    
    if (!candidate) {
      throw new Error('No se obtuvo candidato de la respuesta');
    }
    
    if (candidate.finishReason === 'IMAGE_SAFETY') {
      throw new Error('La imagen fue rechazada por motivos de seguridad');
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
    console.error("Error generando imagen con Gemini:", error);
    throw error;
  }
}

// Ruta para generar/editar imágenes
app.post('/api/generate', async (req, res) => {
  // Obtener token del header de autorización
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ message: 'Token de acceso requerido' });
  }
  
  try {
    // Verificar token contra MongoDB
    const user = await verifyUserToken(token);
    
    const payload = req.body;
    
    // Validar payload
    if (!payload.model || !payload.prompt) {
      return res.status(400).json({ message: 'Modelo y prompt son requeridos' });
    }
    
    const costPerImage = MODEL_COSTS[payload.model] || 8;
    const totalCost = costPerImage;
    
    // Verificar créditos suficientes
    if (user.creditsBalance < totalCost) {
      return res.status(400).json({ 
        message: `Créditos insuficientes. Se necesitan ${totalCost} créditos.` 
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
          "- Modifica la Imagen BASE_CROP. aplicando única y literalmente los cambios del Prompt. No realices ninguna alteración creativa o no solicitada.",
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
    
    // Generar imagen
    result = await generateImageWithGemini(payload, instruction);
    
    // Deduct credits and update user
    const remainingCredits = user.creditsBalance - totalCost;
    await usersCollection.updateOne(
      { _id: user._id },
      { $set: { creditsBalance: remainingCredits } }
    );
    
    // Register transaction
    await transactionsCollection.insertOne({
      userId: user._id,
      operation: payload.operation,
      model: payload.model,
      creditsUsed: totalCost,
      creditsRemaining: remainingCredits,
      timestamp: new Date(),
      success: true
    });
    
    res.json({
      success: true,
      dataUrl: result.dataUrl,
      creditsUsed: totalCost,
      remainingCredits: remainingCredits
    });
  } catch (error) {
    console.error("Error en generación de imagen:", error);
    
    // Si el error es de autenticación, devolver 401
    if (error.message.includes('Token inválido') || error.message.includes('Usuario no encontrado')) {
      return res.status(401).json({ 
        success: false,
        message: error.message
      });
    }
    
    // Si el error es de créditos insuficientes, devolver 400
    if (error.message.includes('Créditos insuficientes')) {
      return res.status(400).json({ 
        success: false,
        message: error.message
      });
    }
    
    // Otros errores
    res.status(500).json({ 
      success: false,
      message: `Error al generar imagen: ${error.message}`
    });
  }
});

// Ruta de salud para Railway
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Endpoint para probar la conexión
app.get('/test', async (req, res) => {
  try {
    await client.db("admin").command({ ping: 1 });
    res.json({ message: 'Conexión a MongoDB exitosa' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Iniciar servidor
async function startServer() {
  try {
    await connectToDatabase();
    
    app.listen(port, () => {
      console.log(`Servidor corriendo en puerto ${port}`);
    });
    
    // Mantener MongoDB conectado
    setInterval(async () => {
      try {
        await client.db("admin").command({ ping: 1 });
        console.log("MongoDB ping exitoso");
      } catch (error) {
        console.error("Error en ping de MongoDB:", error);
        // Intentar reconectar
        await connectToDatabase();
      }
    }, 60000); // Cada minuto
  } catch (error) {
    console.error("Error iniciando servidor:", error);
    process.exit(1);
  }
}

// Manejar señales de apagado
process.on('SIGINT', async () => {
  await client.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await client.close();
  process.exit(0);
});

startServer();
