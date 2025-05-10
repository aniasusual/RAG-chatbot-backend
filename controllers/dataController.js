import Parser from 'rss-parser';
import * as cheerio from 'cheerio';
import axios from 'axios';
import { config } from "dotenv";
import { QdrantClient } from '@qdrant/js-client-rest';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { v4 as uuidv4 } from 'uuid';
// import { RedisStore } from 'connect-redis';
import crypto from 'crypto';
import { redisClient } from '../app.js';

if (process.env.NODE_ENV !== "production") {
    config({ path: "config/config.env" });
}

const JINA_API_KEY = process.env.JINA_API_KEY
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MAX_HISTORY = 50;
const COLLECTION_NAME = 'news_articles';
const CACHE_TTL = 3600; // 1 hour in seconds

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })

let parser = new Parser();

// Initialize Qdrant client
const qdrantClient = new QdrantClient({
    url: QDRANT_URL,
    // apiKey: QDRANT_API_KEY,
});


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

const generateCacheKey = (queryText) => {
    return `query:${crypto.createHash('md5').update(queryText.trim().toLowerCase()).digest('hex')}`;
};

// const commonQueries = [
//     { queryText: 'What is AI?', numberOfPassages: 5 },
//     { queryText: 'How does machine learning work?', numberOfPassages: 5 },
//     { queryText: 'What is a neural network?', numberOfPassages: 5 },
// ];

const generateCommonQueries = async () => {
    try {
        // Get top 10 frequent queries from Redis leaderboard
        const topQueries = await redisClient.zRangeWithScores(QUERY_LEADERBOARD_KEY, 0, 9);
        const frequentQueries = topQueries.map(({ value, score }) => ({
            queryText: value,
            numberOfPassages: 5,
        }));

        // Get trending topics from news articles
        const trendingQueries = await generateTrendingQueries();

        // Combine and deduplicate queries (prioritize frequent queries)
        const combinedQueries = [...frequentQueries, ...trendingQueries];
        const uniqueQueries = Array.from(
            new Map(combinedQueries.map(q => [q.queryText.toLowerCase(), q])).values()
        );

        // Limit to 10 queries
        return uniqueQueries.slice(0, 10);
    } catch (error) {
        console.error('Error generating common queries:', error);
        // Fallback to static queries
        return [
            { queryText: 'What is AI?', numberOfPassages: 5 },
            { queryText: 'How does machine learning work?', numberOfPassages: 5 },
            { queryText: 'What is a neural network?', numberOfPassages: 5 },
        ];
    }
};

const generateTrendingQueries = async () => {
    try {
        // Fetch recent articles from Qdrant
        const results = await qdrantClient.scroll(COLLECTION_NAME, {
            limit: 50,
            with_payload: true,
        });

        const articles = results.points.map(point => ({
            title: point.payload.title,
            fullContent: point.payload.fullContent,
        }));

        // Extract keywords from titles (simple term frequency)
        const keywordCounts = {};
        articles.forEach(({ title }) => {
            const words = title.toLowerCase().split(/\W+/).filter(word =>
                word.length > 3 && !['news', 'latest', 'update', 'report'].includes(word)
            );
            words.forEach(word => {
                keywordCounts[word] = (keywordCounts[word] || 0) + 1;
            });
        });

        // Get top 5 keywords
        const topKeywords = Object.entries(keywordCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([keyword]) => ({
                queryText: `What is ${keyword}?`,
                numberOfPassages: 5,
            }));

        return topKeywords;
    } catch (error) {
        console.error('Error generating trending queries:', error);
        return [];
    }
};


export const warmCache = async () => {
    console.log('Starting cache warming...');
    try {
        for (const { queryText, numberOfPassages } of commonQueries) {
            const cacheKey = generateCacheKey(queryText);
            const cached = await redisClient.get(cacheKey);

            if (!cached) {
                console.log(`Warming cache for query: ${queryText}`);
                const topKPassages = await retrieveTopKPassages(queryText, numberOfPassages);
                const answer = await generateAnswerWithGemini(queryText, topKPassages);
                const cacheData = {
                    passages: topKPassages,
                    answer,
                };
                await redisClient.setEx(cacheKey, 3600, JSON.stringify(cacheData));
                console.log(`Cached query: ${queryText}`);
            } else {
                console.log(`Cache already warm for query: ${queryText}`);
            }
        }
        console.log('Cache warming completed.');
    } catch (error) {
        console.error('Error during cache warming:', error);
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

// Utility to generate cache key from query text

export const queryChatBot = async (req, res) => {
    const { queryText, numberOfPassages = 5 } = req.body;

    if (!queryText || typeof queryText !== 'string') {
        return res.status(400).json({
            success: false,
            message: 'Query text is required and must be a string',
        });
    }

    try {
        // Check cache for existing response
        const cacheKey = generateCacheKey(queryText);
        const cachedResponse = await redisClient.get(cacheKey);

        if (cachedResponse) {
            console.log(`Cache hit for query: ${queryText}`);
            const parsedResponse = JSON.parse(cachedResponse);

            // Store in session history
            if (!req.session.history) {
                req.session.history = [];
            }
            const historyEntry = {
                query: queryText,
                passages: parsedResponse.passages,
                answer: parsedResponse.answer,
                timestamp: new Date().toISOString(),
            };
            if (req.session.history.length >= MAX_HISTORY) {
                req.session.history.shift();
            }
            req.session.history.push(historyEntry);

            return res.status(200).json({
                success: true,
                message: 'Query retrieved from cache',
                query: queryText,
                passages: parsedResponse.passages,
                answer: parsedResponse.answer,
            });
        }

        console.log(`Cache miss for query: ${queryText}`);

        // Retrieve top-k passages
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

        // Store in session history
        if (!req.session.history) {
            req.session.history = [];
        }
        const historyEntry = {
            query: queryText,
            passages: topKPassages,
            answer,
            timestamp: new Date().toISOString(),
        };
        if (req.session.history.length >= MAX_HISTORY) {
            req.session.history.shift();
        }
        req.session.history.push(historyEntry);

        // Cache the response
        const cacheData = {
            passages: topKPassages,
            answer,
        };
        await redisClient.setEx(cacheKey, CACHE_TTL, JSON.stringify(cacheData));
        console.log(`Cached response for query: ${queryText}`);

        res.status(200).json({
            success: true,
            message: 'Query processed successfully',
            query: queryText,
            passages: topKPassages,
            answer,
        });
    } catch (error) {
        console.error('Error in queryChatBot:', error);
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
        console.log("history: ", history);
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
