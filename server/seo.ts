/**
 * SEO and Meta Tag Management
 * Dynamically generates SEO-optimized meta tags for different pages
 */

export interface SEOMetadata {
  title: string;
  description: string;
  keywords?: string[];
  image?: string;
  url: string;
  type?: 'website' | 'article' | 'video';
}

const BASE_URL = 'https://vy-virid.vercel.app';
const BRAND_NAME = 'Stream Vy';
const TAGLINE = 'Free Movies Online | Watch Public Domain Films';

export const seoConfig = {
  home: {
    title: `${BRAND_NAME} - ${TAGLINE}`,
    description: `${BRAND_NAME} is the best free movie streaming platform. Watch thousands of public domain and openly licensed films. Browse by genre, search movies, build your watchlist, and enjoy free streaming. Stream Vy movies online now!`,
    keywords: [
      'free movies',
      'stream movies online',
      'public domain movies',
      'free streaming',
      'vyvirid',
      'stream vy',
      'watch movies free',
      'online cinema',
      'movie database',
      'film streaming',
      'free movie streaming platform',
      'watch public domain films',
    ],
    url: `${BASE_URL}/`,
    type: 'website' as const,
  },
  browse: {
    title: `Browse Movies - ${BRAND_NAME}`,
    description: `Browse and discover thousands of free public domain movies on ${BRAND_NAME}. Filter by genre, year, and more. Find your next favorite film to watch online.`,
    keywords: [
      'browse movies',
      'movie genres',
      'film categories',
      'movie database',
      'public domain films',
    ],
    url: `${BASE_URL}/`,
    type: 'website' as const,
  },
  search: {
    title: `Search Movies - ${BRAND_NAME}`,
    description: `Search our extensive collection of free public domain and openly licensed movies. Find exactly what you want to watch on ${BRAND_NAME}.`,
    keywords: ['movie search', 'find movies', 'search films'],
    url: `${BASE_URL}/`,
    type: 'website' as const,
  },
  terms: {
    title: `Terms of Service - ${BRAND_NAME}`,
    description: `Read the terms of service for ${BRAND_NAME}, the free movie streaming platform.`,
    url: `${BASE_URL}/terms`,
    type: 'website' as const,
  },
  privacy: {
    title: `Privacy Policy - ${BRAND_NAME}`,
    description: `Learn how ${BRAND_NAME} protects your privacy. Read our complete privacy policy.`,
    url: `${BASE_URL}/privacy`,
    type: 'website' as const,
  },
  dmca: {
    title: `Copyright & DMCA - ${BRAND_NAME}`,
    description: `${BRAND_NAME} DMCA policy and copyright information. We respect intellectual property rights.`,
    url: `${BASE_URL}/dmca`,
    type: 'website' as const,
  },
};

/**
 * Generate structured data for movies
 */
export function generateMovieSchema(movie: {
  id: string | number;
  title: string;
  description?: string;
  poster?: string;
  year?: number;
  rating?: number;
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Movie',
    name: movie.title,
    description: movie.description || `${movie.title} - Watch free on ${BRAND_NAME}`,
    image: movie.poster || `${BASE_URL}/stream-vy-mark.svg`,
    datePublished: movie.year ? `${movie.year}-01-01` : undefined,
    aggregateRating: movie.rating
      ? {
          '@type': 'AggregateRating',
          ratingValue: movie.rating,
          bestRating: 10,
          worstRating: 0,
        }
      : undefined,
    url: `${BASE_URL}/watch/${movie.id}`,
  };
}

/**
 * Generate sitemap entry for a movie
 */
export function generateSitemapEntry(path: string, priority: number = 0.7) {
  return {
    url: `${BASE_URL}${path}`,
    changefreq: 'weekly' as const,
    priority,
    lastmod: new Date().toISOString().split('T')[0],
  };
}
