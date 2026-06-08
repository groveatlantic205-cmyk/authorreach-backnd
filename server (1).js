const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

// ─── API Keys (set these in Render environment variables) ─────────────────────
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;   // from tavily.com (FREE)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;   // from aistudio.google.com (FREE)

// ─── Simple in-memory cache (30 days TTL) ─────────────────────────────────────
const cache = new Map();
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Tavily Search Helper ─────────────────────────────────────────────────────
async function tavilySearch(query) {
  const response = await axios.post(
    "https://api.tavily.com/search",
    {
      api_key: TAVILY_API_KEY,
      query,
      search_depth: "advanced",
      include_answer: true,
      include_raw_content: false,
      max_results: 5,
    },
    { timeout: 15000 }
  );
  return response.data;
}

// ─── Gemini AI Helper ─────────────────────────────────────────────────────────
async function geminiAnalyze(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const response = await axios.post(
    url,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2000,
      },
    },
    { timeout: 30000 }
  );
  return response.data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// ─── Main Author Search Function ──────────────────────────────────────────────
async function searchAuthor(authorName) {
  // Check cache first
  const cacheKey = authorName.toLowerCase().trim();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log(`Cache hit: ${authorName}`);
    return { ...cached.data, from_cache: true };
  }

  console.log(`Live search: ${authorName}`);

  // ── Step 1: Run all Tavily searches in parallel ──────────────────────────
  const searches = await Promise.allSettled([
    tavilySearch(`${authorName} amazon author central`),
    tavilySearch(`${authorName} goodreads author profile`),
    tavilySearch(`${authorName} official author website contact email`),
    tavilySearch(`${authorName} publisher page literary agent`),
    tavilySearch(`${authorName} twitter linkedin instagram email contact`),
    tavilySearch(`${authorName} substack newsletter email`),
  ]);

  // Collect all results into one big text block
  const searchLabels = [
    "AMAZON AUTHOR CENTRAL",
    "GOODREADS",
    "PERSONAL WEBSITE",
    "PUBLISHER / AGENCY",
    "SOCIAL MEDIA",
    "NEWSLETTER / SUBSTACK",
  ];

  let combinedResults = "";
  searches.forEach((result, i) => {
    combinedResults += `\n\n=== ${searchLabels[i]} SEARCH RESULTS ===\n`;
    if (result.status === "fulfilled") {
      const data = result.value;
      if (data.answer) combinedResults += `Summary: ${data.answer}\n`;
      data.results?.forEach((r) => {
        combinedResults += `- Title: ${r.title}\n  URL: ${r.url}\n  Snippet: ${r.content?.slice(0, 300)}\n`;
      });
    } else {
      combinedResults += `Search failed: ${result.reason?.message}\n`;
    }
  });

  // ── Step 2: Send all results to Gemini for analysis ──────────────────────
  const geminiPrompt = `You are an author research and verification engine called AuthorReach.

I have searched the web for publicly available information about the author: "${authorName}"

Here are the raw search results from 6 different source categories:
${combinedResults}

YOUR TASK:
1. Analyze all the search results above carefully
2. Extract verified public information about this author
3. For email addresses: ONLY include an email if you can find it mentioned in at least 3 different source URLs above. It must be an exact match. If fewer than 3 sources confirm the same email, set email to null.
4. Calculate a verification score based on which sources were found:
   - Amazon Author Central found: +30 points
   - Personal website found: +20 points
   - Goodreads profile found: +15 points
   - Publisher/agency page found: +15 points
   - Each social media source found: +10 points
   - Email confirmed on 3+ sources: +20 bonus points

5. Return ONLY a raw JSON object. No markdown, no backticks, no explanation. Just the JSON.

Use this exact format:
{
  "name": "Full Author Name",
  "photo": "direct image URL or null",
  "bio": "author bio max 300 characters",
  "genre": ["genre1", "genre2"],
  "books": [
    { "title": "Book Title", "year": 2020, "amazon_url": "url or null" }
  ],
  "email": "verified@email.com or null",
  "email_verified_sources": ["url1", "url2", "url3"],
  "email_source_count": 0,
  "website": "https://authorwebsite.com or null",
  "amazon_url": "https://amazon.com/author/... or null",
  "goodreads_url": "https://goodreads.com/author/... or null",
  "social": {
    "twitter": "https://twitter.com/handle or null",
    "instagram": "https://instagram.com/handle or null",
    "linkedin": "https://linkedin.com/in/handle or null",
    "substack": "https://name.substack.com or null"
  },
  "sources": [
    { "name": "Amazon Author Central", "url": "url or null", "found": true },
    { "name": "Goodreads", "url": "url or null", "found": true },
    { "name": "Personal Website", "url": "url or null", "found": false },
    { "name": "Publisher Page", "url": "url or null", "found": false },
    { "name": "Twitter/X", "url": "url or null", "found": false },
    { "name": "LinkedIn", "url": "url or null", "found": false }
  ],
  "verification_score": 0,
  "last_verified": "${new Date().toISOString()}"
}`;

  const geminiResponse = await geminiAnalyze(geminiPrompt);

  // ── Step 3: Parse the JSON response ─────────────────────────────────────
  let authorData;
  try {
    const clean = geminiResponse.replace(/```json|```/g, "").trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON object found in Gemini response");
    authorData = JSON.parse(jsonMatch[0]);
  } catch (err) {
    throw new Error(`Failed to parse Gemini response: ${err.message}`);
  }

  authorData.last_verified = new Date().toISOString();
  authorData.from_cache = false;

  // Save to cache
  cache.set(cacheKey, { data: authorData, timestamp: Date.now() });

  return authorData;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Search single author
app.get("/api/author/:name", async (req, res) => {
  const { name } = req.params;
  if (!name || name.trim().length < 2) {
    return res.status(400).json({ error: "Author name must be at least 2 characters" });
  }
  try {
    const data = await searchAuthor(decodeURIComponent(name));
    res.json({ success: true, data });
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Batch search (up to 5 authors)
app.post("/api/authors/batch", async (req, res) => {
  const { names } = req.body;
  if (!Array.isArray(names) || names.length === 0) {
    return res.status(400).json({ error: "Provide an array of author names" });
  }
  if (names.length > 5) {
    return res.status(400).json({ error: "Max 5 authors per batch" });
  }
  try {
    const results = await Promise.allSettled(names.map(searchAuthor));
    const data = results.map((r, i) => ({
      name: names[i],
      success: r.status === "fulfilled",
      data: r.status === "fulfilled" ? r.value : null,
      error: r.status === "rejected" ? r.reason.message : null,
    }));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Force re-verify (bypass cache)
app.post("/api/author/:name/reverify", async (req, res) => {
  const cacheKey = decodeURIComponent(req.params.name).toLowerCase().trim();
  cache.delete(cacheKey);
  try {
    const data = await searchAuthor(decodeURIComponent(req.params.name));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Cache stats
app.get("/api/cache/stats", (req, res) => {
  res.json({ cached_authors: cache.size, entries: Array.from(cache.keys()) });
});

// Health check
app.get("/health", (req, res) => res.json({ status: "ok", engine: "Tavily + Gemini (Free)" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`AuthorReach FREE backend running on port ${PORT}`));
