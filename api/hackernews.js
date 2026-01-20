export const config = { runtime: 'edge' };

// Fetch Hacker News front page stories
// Uses official HackerNews Firebase API
export default async function handler(request) {
  try {
    const { searchParams } = new URL(request.url);
    const storyType = searchParams.get('type') || 'top'; // top, new, best, ask, show, job
    const limit = parseInt(searchParams.get('limit') || '30', 10);

    // HackerNews official Firebase API
    const storiesUrl = `https://hacker-news.firebaseio.com/v0/${storyType}stories.json`;

    // Fetch story IDs
    const storiesResponse = await fetch(storiesUrl, {
      signal: AbortSignal.timeout(10000),
    });

    if (!storiesResponse.ok) {
      throw new Error(`HackerNews API returned ${storiesResponse.status}`);
    }

    const storyIds = await storiesResponse.json();
    const limitedIds = storyIds.slice(0, limit);

    // Fetch story details in parallel (batch of 30)
    const storyPromises = limitedIds.map(async (id) => {
      const storyUrl = `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
      try {
        const response = await fetch(storyUrl, {
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          return await response.json();
        }
        return null;
      } catch (error) {
        console.error(`Failed to fetch story ${id}:`, error);
        return null;
      }
    });

    const stories = (await Promise.all(storyPromises)).filter(story => story !== null);

    return new Response(JSON.stringify({
      type: storyType,
      stories: stories,
      total: stories.length,
      timestamp: new Date().toISOString()
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300', // 5 min cache
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Failed to fetch Hacker News data',
        message: error.message
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
      }
    );
  }
}
