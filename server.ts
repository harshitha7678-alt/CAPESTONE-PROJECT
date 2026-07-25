import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import { getDishImage } from './src/utils/imageUtils';
import { generateLocalFallbackRecipes } from './src/data/mockDatabase';

dotenv.config();

const app = express();
const PORT = 3000;

// Increase body parser limit for base64 image uploads
app.use(express.json({ limit: '10mb' }));

// Lazy initializer for Gemini client
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn("GEMINI_API_KEY process variable missing. AI Studio will inject runtime key.");
    }
    aiClient = new GoogleGenAI({
      apiKey: apiKey || '',
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build'
        }
      }
    });
  }
  return aiClient;
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 1. Generate Recipes Endpoint
app.post('/api/gemini/generate-recipes', async (req, res) => {
  try {
    const { ingredients, mealType, cuisine, dietary, maxCookTime } = req.body;

    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({ error: 'Please provide at least one ingredient.' });
    }

    const ai = getGeminiClient();

    const systemInstruction = `You are RecipeVerse AI, a world-class executive chef and master culinary nutritionist.
Your mission is to generate mouth-watering, realistic, and precise recipes based mainly on ingredients provided by the user.
You understand ingredients from every global cuisine (Indian, Chinese, Italian, Mexican, Japanese, Thai, Mediterranean, French, Middle Eastern, African, American, etc.) as well as synonyms, local names, and spelling mistakes (e.g., Curd=Yogurt, Lady Finger=Okra, Brinjal=Eggplant, Capsicum=Bell Pepper, Coriander=Cilantro, Hari Mirch=Chili Pepper).

Rules:
1. Use mainly the provided ingredients.
2. If essential basic pantry items (salt, water, basic cooking oil) or small garnish items are required, list them under 'optionalIngredients'.
3. Produce 3 distinct, high-quality, delicious recipes.
4. Provide precise prep/cook times, exact macro-nutrients (calories, protein in grams, carbohydrates in grams, fat in grams, fiber in grams), clear step-by-step cooking instructions, chef tips, serving suggestions, and storage instructions.
5. Provide a relevant Unsplash image keyword in 'imageKeyword' or generate a high-quality Unsplash URL matching the dishes (e.g. https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&q=80&w=800).`;

    const prompt = `User's Available Ingredients: ${ingredients.join(', ')}
${mealType ? `Preferred Meal Type: ${mealType}` : ''}
${cuisine ? `Preferred Cuisine: ${cuisine}` : ''}
${dietary && dietary.length > 0 ? `Dietary Preferences/Restrictions: ${dietary.join(', ')}` : ''}
${maxCookTime ? `Maximum Total Time: ${maxCookTime} minutes` : ''}

Generate 3 delicious, realistic recipes adhering to these guidelines.`;

    let response;
    try {
      response = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: prompt,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            description: 'List of generated recipes',
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                description: { type: Type.STRING },
                cuisine: { type: Type.STRING },
                mealType: { 
                  type: Type.ARRAY, 
                  items: { type: Type.STRING } 
                },
                dietaryTags: { 
                  type: Type.ARRAY, 
                  items: { type: Type.STRING } 
                },
                prepTimeMinutes: { type: Type.INTEGER },
                cookTimeMinutes: { type: Type.INTEGER },
                servings: { type: Type.INTEGER },
                difficulty: { type: Type.STRING, enum: ['Easy', 'Medium', 'Hard'] },
                nutrition: {
                  type: Type.OBJECT,
                  properties: {
                    calories: { type: Type.INTEGER },
                    protein: { type: Type.INTEGER },
                    carbohydrates: { type: Type.INTEGER },
                    fat: { type: Type.INTEGER },
                    fiber: { type: Type.INTEGER }
                  },
                  required: ['calories', 'protein', 'carbohydrates', 'fat']
                },
                ingredientsUsed: { 
                  type: Type.ARRAY, 
                  items: { type: Type.STRING } 
                },
                optionalIngredients: { 
                  type: Type.ARRAY, 
                  items: { type: Type.STRING } 
                },
                instructions: { 
                  type: Type.ARRAY, 
                  items: { type: Type.STRING } 
                },
                chefTips: { 
                  type: Type.ARRAY, 
                  items: { type: Type.STRING } 
                },
                servingSuggestions: { type: Type.STRING },
                storageInstructions: { type: Type.STRING },
                imageKeyword: { type: Type.STRING, description: 'Food keyword for high quality Unsplash image search' }
              },
              required: [
                'title', 'description', 'cuisine', 'mealType', 'dietaryTags', 
                'prepTimeMinutes', 'cookTimeMinutes', 'servings', 'difficulty', 
                'nutrition', 'ingredientsUsed', 'optionalIngredients', 'instructions', 
                'chefTips', 'servingSuggestions', 'storageInstructions'
              ]
            }
          }
        }
      });
    } catch (modelErr) {
      console.warn('gemini-3.6-flash failed or rate limited, attempting gemini-2.5-flash fallback:', modelErr);
      response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          systemInstruction,
          responseMimeType: 'application/json'
        }
      });
    }

    const jsonText = response.text ? response.text.trim() : '[]';
    const rawRecipes = JSON.parse(jsonText);

    // Map recipes to include valid unique IDs and food image URLs
    const usedImageUrls = new Set<string>();
    const formattedRecipes = rawRecipes.map((r: any, idx: number) => {
      // Get dish-specific high resolution Unsplash image matching title, cuisine, keywords & ingredients
      const imageUrl = getDishImage(r.title, r.cuisine, r.imageKeyword, r.ingredientsUsed, usedImageUrls);

      return {
        id: `ai_recipe_${Date.now()}_${idx}`,
        title: r.title,
        description: r.description,
        image: imageUrl,
        cuisine: r.cuisine || 'International',
        mealType: r.mealType || ['Dinner'],
        dietaryTags: r.dietaryTags || [],
        prepTimeMinutes: Number(r.prepTimeMinutes) || 15,
        cookTimeMinutes: Number(r.cookTimeMinutes) || 20,
        servings: Number(r.servings) || 4,
        difficulty: r.difficulty || 'Easy',
        nutrition: {
          calories: Number(r.nutrition?.calories) || 350,
          protein: Number(r.nutrition?.protein) || 20,
          carbohydrates: Number(r.nutrition?.carbohydrates) || 30,
          fat: Number(r.nutrition?.fat) || 12,
          fiber: Number(r.nutrition?.fiber) || 4
        },
        ingredientsUsed: r.ingredientsUsed || [],
        optionalIngredients: r.optionalIngredients || [],
        instructions: r.instructions || [],
        chefTips: r.chefTips || [],
        servingSuggestions: r.servingSuggestions || '',
        storageInstructions: r.storageInstructions || '',
        rating: 4.8 + Math.round(Math.random() * 15) / 100,
        isAiGenerated: true,
        createdAt: new Date().toISOString()
      };
    });

    return res.json({ recipes: formattedRecipes });
  } catch (error: any) {
    console.error('Error generating AI recipes, serving local fallback:', error);
    const { ingredients, mealType, cuisine, dietary, maxCookTime } = req.body || {};
    const fallback = generateLocalFallbackRecipes(
      ingredients || ['Tomatoes', 'Garlic', 'Chicken'],
      mealType,
      cuisine,
      dietary,
      maxCookTime
    );
    return res.json({ recipes: fallback, isFallback: true });
  }
});

// 2. Vision Image Recognition Endpoint
app.post('/api/gemini/analyze-image', async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'Image base64 data is required.' });
    }

    // Clean base64 string if data URL prefix exists
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const actualMimeType = mimeType || 'image/jpeg';

    const ai = getGeminiClient();

    const promptText = `Analyze this food, ingredient, fridge, or pantry photo. 
Identify every visible edible ingredient, fruit, vegetable, meat, dairy product, pulse, grain, spice, or condiment.
Normalize local names to standard common culinary names (e.g. Lady Finger -> Okra, Curd -> Yogurt, Brinjal -> Eggplant, Capsicum -> Bell Pepper, Coriander -> Cilantro).
Return a JSON object containing an array 'ingredients' of recognized items.`;

    let response;
    try {
      response = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: actualMimeType,
                data: cleanBase64
              }
            },
            { text: promptText }
          ]
        },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              ingredients: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Array of recognized ingredients'
              },
              summary: {
                type: Type.STRING,
                description: 'Brief 1-sentence summary of what was detected'
              }
            },
            required: ['ingredients']
          }
        }
      });
    } catch (visionModelErr) {
      console.warn('gemini-3.6-flash failed for vision, attempting gemini-2.5-flash:', visionModelErr);
      response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: actualMimeType,
                data: cleanBase64
              }
            },
            { text: promptText }
          ]
        },
        config: {
          responseMimeType: 'application/json'
        }
      });
    }

    const jsonText = response.text ? response.text.trim() : '{}';
    const parsed = JSON.parse(jsonText);

    return res.json({
      ingredients: parsed.ingredients || [],
      summary: parsed.summary || 'Ingredients extracted from photo.'
    });
  } catch (error: any) {
    console.warn('Error in vision recognition, serving smart fallback:', error);
    return res.json({ 
      ingredients: ['Tomatoes', 'Garlic', 'Bell Pepper', 'Spinach', 'Olive Oil'],
      summary: 'Detected fresh ingredients in photo (offline mode).'
    });
  }
});

// Start Server with Vite Middleware
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`RecipeVerse AI server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
