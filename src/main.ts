// Importaciones necesarias de Genkit y otras librerías.
import "dotenv/config"; // Carga variables de entorno desde .env
import { genkit, z } from "genkit";
import { gemini20Flash, googleAI } from "@genkit-ai/googleai";
import { textEmbedding004, vertexAI } from "@genkit-ai/vertexai";
import { devLocalIndexerRef, devLocalVectorstore, devLocalRetrieverRef } from "@genkit-ai/dev-local-vectorstore";
import { Document} from "genkit/retriever"
import path from "path";
import pdf from "pdf-parse"; // Librería para leer texto de archivos PDF.
import fs from "fs";       // Módulo de Node.js para interactuar con el sistema de archivos.
import { chunk } from "llm-chunk"; // Utilidad para dividir texto largo en trozos manejables.

const PDF_INDEX_NAME = "pdf-index";

/**
 * Configuración principal de Genkit.
 * Aquí se "enchufan" todos los servicios que la aplicación utilizará.
 */
const ai = genkit({
  plugins: [
    // Plugin para conectar con Vertex AI de Google Cloud.
    // Requiere autenticación de gcloud y un proyecto con facturación habilitada.
    vertexAI({
      location: "us-central1", // Ubicación de los servicios de Vertex AI.
      projectId: "Reemplazar con tu Project ID",
    }),
    // Plugin para conectar con Google AI Studio (Modelos Gemini).
    // Utiliza una API Key definida en el archivo .env.
    googleAI(),
    // Plugin para crear una base de datos de vectores local.
    // Esta base de datos almacena los "embeddings" (representaciones numéricas)
    // del texto para poder realizar búsquedas semánticas.
    devLocalVectorstore([
      {
        indexName: PDF_INDEX_NAME, // Nombre único para este índice. Como un "nombre de tabla".
        embedder: textEmbedding004, // Modelo específico que se usará para crear los vectores.
      },
    ]),
  ],
});

// =================================================================================
// FLUJO DE INDEXACIÓN: Proceso de leer un PDF y almacenarlo en la base de datos.
// =================================================================================

/**
 * Referencia al "Indexer" (Indexador).
 * Un indexador es el responsable de tomar documentos, convertirlos en vectores
 * y guardarlos en el almacén de vectores (`devLocalVectorstore`).
 * Lo exportamos para que Genkit lo reconozca y lo muestre en su UI.
 */
export const pdfIndexer = devLocalIndexerRef(PDF_INDEX_NAME);

/**
 * Define un "Flow" (Flujo) de Genkit para la indexación de documentos.
 * Un Flow es una tarea o proceso que puede ser ejecutado y monitoreado.
 * Este flujo toma la ruta de un archivo PDF y no devuelve nada (outputSchema: z.void()).
 * Lo exportamos para que sea visible y ejecutable desde la UI de Genkit.
 */
export const indexerDocuments = ai.defineFlow(
  {
    name: "indexerDocuments",
    inputSchema: z.string().describe("Ruta al archivo PDF a indexar"),
    outputSchema: z.void(),
  },
  async (filePath: string): Promise<void> => {
    // Convierte la ruta relativa a una ruta absoluta.
    filePath = path.resolve(filePath);

    // Lee el contenido del archivo PDF y extrae su texto.
    const pdfText = await pdf(fs.readFileSync(filePath));

    // Divide el texto extraído en trozos (chunks) más pequeños.
    // Esto es crucial porque los modelos de IA tienen un límite de contexto
    // y procesan mejor la información en porciones más pequeñas y enfocadas.
    const chunks = await chunk(pdfText.text,{
      minLength: 1000,
      maxLength: 2000,
      splitter: "sentence", // Intenta dividir por oraciones.
      overlap: 100, // Superposición de caracteres entre trozos para no perder contexto.
      delimiters: "",
    });

    // Convierte cada trozo de texto en un objeto `Document` de Genkit.
    const docs: Document[] = chunks.map((chunk) => {
      return Document.fromText(chunk, {filePath})
    });

    // Comando principal para indexar.
    // Le dice a Genkit que use el indexador `cop16PdfIndexer` para procesar
    // y almacenar la lista de documentos (`docs`) en la base de datos de vectores.
    await ai.index({
      indexer: pdfIndexer,
      documents: docs
    });
  }
);

// =================================================================================
// FLUJO DE RECUPERACIÓN: Proceso de buscar información y generar una respuesta.
// =================================================================================

/**
 * Referencia al "Retriever" (Recuperador).
 * Un recuperador se encarga de buscar en el almacén de vectores los documentos
 * más relevantes para una pregunta (query) específica.
 */
const pdfRetriever = devLocalRetrieverRef(PDF_INDEX_NAME);

/**
 * Define un "Flow" para la recuperación de documentos y generación de respuestas.
 * Este flujo toma una pregunta (string) y devuelve una respuesta (string).
 * Lo exportamos para que sea visible y ejecutable desde la UI de Genkit.
 */
export const documentQA = ai.defineFlow(
  {
    name: "documentQA",
    inputSchema: z.string().describe("Pregunta sobre el documento"),
    outputSchema: z.string(),
  },
  async (query: string): Promise<string> => {
    
    // 1. FASE DE RECUPERACIÓN (Retrieval)
    // Usa el recuperador para encontrar los documentos más relevantes para la `query`.
    const docs = await ai.retrieve({
      retriever: pdfRetriever,
      query, // La pregunta del usuario.
      options: { k: 3 }, // Pide los 3 trozos de texto más relevantes.
    });

    // 2. FASE DE GENERACIÓN (Generation)
    // Llama al modelo de IA (gemini20Flash) para generar una respuesta.
    const { text } = await ai.generate({
      model: gemini20Flash,
      // El prompt le da instrucciones a la IA sobre cómo comportarse.
      prompt: `
        Eres un asistente de IA diseñado para responder preguntas basándote en un contexto específico.

        Usa únicamente el contexto de los documentos proporcionados para responder la pregunta.
        Si la respuesta no se encuentra en el contexto, indica claramente que no tienes la información. No inventes una respuesta.

        Pregunta: ${query}`,
      // ¡La magia de RAG! Se pasa el contexto recuperado (`docs`) a la IA.
      // La IA basará su respuesta en estos documentos, no en su conocimiento general.
      docs,
    });
    
    // Devuelve el texto de la respuesta generada.
    return text;
  }
);