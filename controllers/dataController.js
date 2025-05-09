import Parser from 'rss-parser';
import * as cheerio from 'cheerio';
import axios from 'axios';
import { config } from "dotenv";
import { QdrantClient } from '@qdrant/js-client-rest';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { v4 as uuidv4 } from 'uuid';
// import { RedisStore } from 'connect-redis';

if (process.env.NODE_ENV !== "production") {
    config({ path: "config/config.env" });
}

const JINA_API_KEY = process.env.JINA_API_KEY
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
// const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const MAX_HISTORY = 50;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })

let parser = new Parser();

// Initialize Qdrant client
const qdrantClient = new QdrantClient({
    url: QDRANT_URL,
    // apiKey: QDRANT_API_KEY,
});

const COLLECTION_NAME = 'news_articles';

// Create collection on application startup
const initializeQdrant = async () => {
    try {
        const collections = await qdrantClient.getCollections();
        const collectionExists = collections.collections.some(
            (c) => c.name === COLLECTION_NAME
        );

        if (!collectionExists) {
            await qdrantClient.createCollection(COLLECTION_NAME, {
                vectors: {
                    size: 768, // Jina embeddings v2 base model output size
                    distance: 'Cosine',
                },
            });
            console.log(`Collection ${COLLECTION_NAME} created.`);
        } else {
            console.log(`Collection ${COLLECTION_NAME} already exists.`);
        }
    } catch (error) {
        console.error('Error initializing Qdrant collection:', error);
        throw error; // Optionally, stop the app if Qdrant setup fails
    }
};

// Call initializeQdrant when the application starts
initializeQdrant().catch((err) => {
    console.error('Failed to initialize Qdrant:', err);
    process.exit(1); // Exit if initialization fails
});

const storeEmbeddings = async (articles, embeddings) => {
    try {
        const points = articles.map((article, idx) => ({
            id: uuidv4(), // Consider using UUID for production
            vector: embeddings[idx] || [],
            payload: {
                title: article.title,
                link: article.link,
                fullContent: article.fullContent,
                pubDate: article.pubDate,
            },
        }));

        await qdrantClient.upsert(COLLECTION_NAME, {
            points,
        });
        console.log('Embeddings stored in Qdrant.');
    } catch (error) {
        console.error('Error storing embeddings:', error);
    }
};

const embedWithJina = async (texts) => {
    try {
        const response = await axios.post(
            'https://api.jina.ai/v1/embeddings',
            {
                input: texts,
                model: 'jina-embeddings-v2-base-en' // current available model
            },
            {
                headers: {
                    Authorization: `Bearer ${JINA_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        )
        return response.data.data.map((d) => d.embedding); // array of vectors

    } catch (error) {
        console.log("error in embeddings: ", error);
    }
}

const scrapeFullContent = async (url) => {
    try {
        const { data } = await axios.get(url);
        const $ = cheerio.load(data);
        const paragraphs = $('article p').map((_, el) => $(el).text()).get();
        return paragraphs.join(' ').trim();
    } catch (err) {
        console.error(`Error scraping ${url}:`, err.message);
        return '';
    }
};

const generateAnswerWithGemini = async (query, passages) => {
    try {
        // Format context from passages
        const context = passages
            .map((p, idx) => `Passage ${idx + 1}: ${p.title}\n${p.fullContent}`)
            .join('\n\n');

        // Construct prompt
        const prompt = `
            You are a helpful assistant. Based on the following context, provide a concise and accurate answer to the query: "${query}"

            Context:
            ${context}

            Answer:
        `;

        // Call Gemini API
        const result = await geminiModel.generateContent(prompt);
        const answer = result.response.text().trim();

        return answer;
    } catch (error) {
        console.error('Error generating answer with Gemini:', error);
        return 'Failed to generate answer';
    }
};

const retrieveTopKPassages = async (query, k = 5) => {
    try {
        // Generate embedding for the query
        const queryEmbedding = await embedWithJina([query]);
        if (!queryEmbedding || queryEmbedding.length === 0) {
            throw new Error('Failed to generate query embedding');
        }

        // Search Qdrant for top-k similar passages
        const results = await qdrantClient.search(COLLECTION_NAME, {
            vector: queryEmbedding[0],
            limit: k,
            with_payload: true,
        });

        // Format results
        return results.map((result) => ({
            id: result.id,
            score: result.score,
            title: result.payload.title,
            link: result.payload.link,
            fullContent: result.payload.fullContent,
            pubDate: result.payload.pubDate,
        }));
    } catch (error) {
        console.error('Error retrieving passages:', error);
        return [];
    }
};

export const getAllData = async (req, res) => {
    const feedUrls = [
        'http://feeds.bbci.co.uk/news/rss.xml',
        'http://feeds.bbci.co.uk/news/world/rss.xml',
        'http://feeds.bbci.co.uk/news/technology/rss.xml',
    ];

    try {
        // await createCollection();

        const allArticles = [];

        for (const url of feedUrls) {
            const feed = await parser.parseURL(url);
            allArticles.push(...feed.items);
        }

        const unique = Array.from(new Map(allArticles.map(a => [a.link, a])).values());

        // Inject full content
        const articlesWithFullContent = await Promise.all(
            unique.map(async (article) => {
                const fullText = await scrapeFullContent(article.link);
                return {
                    ...article,
                    fullContent: fullText || article.contentSnippet,
                };
            })
        );
        // Prepare texts to embed (e.g., title + content)
        const textsToEmbed = articlesWithFullContent.map(
            a => `${a.title}. ${a.fullContent}`
        );

        // Call Jina
        const embeddings = await embedWithJina(textsToEmbed);

        await storeEmbeddings(articlesWithFullContent, embeddings);

        // Attach embeddings back to articles
        const embeddedArticles = articlesWithFullContent.map((article, idx) => ({
            ...article,
            embedding: embeddings[idx] || []
        }));

        res.status(200).json({
            success: true,
            message: 'feed retrieved successfully',
            // articles: articlesWithFullContent,
            embeddedArticles
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};


export const queryChatBot = async (req, res) => {
    const { queryText, numberOfPassages = 5 } = req.body;

    console.log(queryText);

    if (!queryText || typeof queryText !== 'string') {
        return res.status(400).json({
            success: false,
            message: 'Query text is required and must be a string',
        });
    }

    try {
        // Retrieve top-k passages (default k=5)
        const topKPassages = await retrieveTopKPassages(queryText, numberOfPassages);

        if (topKPassages.length === 0) {
            return res.status(200).json({
                success: true,
                message: 'No relevant passages found',
                answer: 'No relevant information available to answer the query.',
            });
        }

        // Generate answer with Gemini
        const answer = await generateAnswerWithGemini(queryText, topKPassages);

        if (!req.session.history) {
            req.session.history = [];
        }

        // Store query and response in session history
        const historyEntry = {
            query: queryText,
            passages: topKPassages,
            answer,
            timestamp: new Date().toISOString(),
        };

        if (req.session.history.length >= MAX_HISTORY) {
            req.session.history.shift(); // Remove oldest entry
        }
        req.session.history.push(historyEntry);

        res.status(200).json({
            success: true,
            message: 'Query processed successfully',
            query: queryText,
            passages: topKPassages,
            answer,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};

// Endpoint to fetch session history
export const getSessionHistory = async (req, res) => {
    try {
        const history = req.session.history || [];
        res.status(200).json({
            success: true,
            message: 'Session history retrieved successfully',
            history,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};

// Endpoint to clear session history
export const clearSession = async (req, res) => {
    try {
        req.session.history = []; // Clear history
        await req.session.save(); // Ensure session is saved to Redis
        req.session.destroy((err) => {
            if (err) {
                throw err;
            }
            res.status(200).json({
                success: true,
                message: 'Session cleared successfully',
            });
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};
