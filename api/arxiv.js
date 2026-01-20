export const config = { runtime: 'edge' };

// Fetch AI/ML papers from ArXiv
// Categories: cs.AI, cs.LG (Machine Learning), cs.CL (Computation and Language)
export default async function handler(request) {
  try {
    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category') || 'cs.AI'; // cs.AI, cs.LG, cs.CL
    const maxResults = searchParams.get('max_results') || '50';
    const sortBy = searchParams.get('sortBy') || 'submittedDate'; // submittedDate, lastUpdatedDate, relevance

    // ArXiv API search query
    // Search for papers in specified category, sorted by date
    const query = `cat:${category}`;
    const apiUrl = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&start=0&max_results=${maxResults}&sortBy=${sortBy}&sortOrder=descending`;

    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'WorldMonitor/1.0 (AI Research Tracker)',
      },
    });

    if (!response.ok) {
      throw new Error(`ArXiv API returned ${response.status}`);
    }

    const xmlData = await response.text();

    // Parse XML to extract key information
    // Return raw XML for client-side parsing or transform here
    return new Response(xmlData, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600', // 1 hour cache
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Failed to fetch ArXiv data',
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
