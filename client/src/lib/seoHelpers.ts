/**
 * SEO Helper utilities for client-side optimization
 */

export interface MetaTagConfig {
  title: string;
  description: string;
  keywords?: string[];
  image?: string;
  url?: string;
  type?: 'website' | 'article' | 'video';
  twitterHandle?: string;
}

/**
 * Update document head with SEO meta tags
 * Call this on route changes for dynamic page SEO
 */
export function updateMetaTags(config: MetaTagConfig) {
  // Update title
  document.title = config.title;

  // Update or create description meta tag
  updateOrCreateMetaTag('description', config.description);

  // Update or create keywords meta tag
  if (config.keywords?.length) {
    updateOrCreateMetaTag('keywords', config.keywords.join(', '));
  }

  // Update Open Graph tags
  updateOrCreateMetaTag('property', 'og:title', config.title, true);
  updateOrCreateMetaTag('property', 'og:description', config.description, true);
  updateOrCreateMetaTag('property', 'og:type', config.type || 'website', true);
  if (config.url) {
    updateOrCreateMetaTag('property', 'og:url', config.url, true);
  }
  if (config.image) {
    updateOrCreateMetaTag('property', 'og:image', config.image, true);
  }

  // Update Twitter tags
  updateOrCreateMetaTag('name', 'twitter:title', config.title, false);
  updateOrCreateMetaTag('name', 'twitter:description', config.description, false);
  if (config.image) {
    updateOrCreateMetaTag('name', 'twitter:image', config.image, false);
  }

  // Update canonical URL
  if (config.url) {
    updateCanonicalLink(config.url);
  }
}

/**
 * Update or create a meta tag with the given name/property and content
 */
function updateOrCreateMetaTag(
  attribute: 'name' | 'property',
  attributeValue: string,
  content: string,
  isProperty: boolean = false
) {
  const selector = isProperty
    ? `meta[property="${attributeValue}"]`
    : `meta[name="${attributeValue}"]`;

  let tag = document.querySelector(selector) as HTMLMetaElement | null;

  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute(attribute, attributeValue);
    document.head.appendChild(tag);
  }

  tag.content = content;
}

/**
 * Update or create canonical link
 */
function updateCanonicalLink(url: string) {
  let link = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;

  if (!link) {
    link = document.createElement('link');
    link.rel = 'canonical';
    document.head.appendChild(link);
  }

  link.href = url;
}

/**
 * Generate JSON-LD structured data
 */
export function injectStructuredData(schema: Record<string, unknown>) {
  const script = document.createElement('script');
  script.type = 'application/ld+json';
  script.textContent = JSON.stringify(schema);
  document.head.appendChild(script);
}

/**
 * Track page views for analytics (when analytics is enabled)
 */
export function trackPageView(pageName: string, pageTitle?: string) {
  if (typeof window !== 'undefined' && (window as any).gtag) {
    (window as any).gtag('event', 'page_view', {
      page_path: pageName,
      page_title: pageTitle || document.title,
    });
  }
}

/**
 * Build search-optimized URL with tracking parameters
 */
export function buildOptimizedUrl(path: string, params?: Record<string, string>) {
  const url = new URL(path, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });
  }
  return url.toString();
}
