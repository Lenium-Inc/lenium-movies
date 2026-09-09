import { Star, Play, Bookmark, Check, Clock } from 'lucide-react';
import type { Movie } from './types';

interface MovieCardProps {
  movie: Movie;
  saved?: boolean;
  onSelect: () => void;
  onSave: () => void;
}

function formatRuntime(minutes: string | number | undefined): string {
  if (!minutes) return "";
  const mins = typeof minutes === "string" ? parseInt(minutes.replace("m", "")) : minutes;
  if (isNaN(mins)) return "";
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return hours > 0 ? `${hours}h ${remainingMins}m` : `${remainingMins}m`;
}

function formatRating(score: number | null | undefined): string {
  if (score === null || score === undefined) return "";
  return score.toFixed(1);
}

export const MovieCard: React.FC<MovieCardProps> = ({ movie, saved, onSelect, onSave }) => {
  const posterUrl = movie.poster || `https://via.placeholder.com/500x750?text=${encodeURIComponent(movie.title)}`;
  const releaseYear = movie.year?.toString() || 'Unknown';
  const voteAverage = formatRating(movie.vote_average ?? movie.score);
  const genres = movie.genre || movie.genres || [];
  const mediaType = movie.mediaType || 'movie';
  const runtime = formatRuntime(movie.runtime);
  const synopsis = movie.synopsis || movie.overview;

  return (
    <article
      onClick={onSelect}
      className="group relative bg-zinc-900/50 rounded-xl overflow-hidden cursor-pointer transform transition-all duration-300 hover:scale-105 hover:z-20 border border-white/5"
    >
      <div className="aspect-[2/3] w-full overflow-hidden bg-zinc-800 relative">
        <img
          src={posterUrl}
          alt={movie.title}
          className="w-full h-full object-cover transition-opacity duration-300 group-hover:opacity-90 group-hover:scale-[1.02]"
          loading="lazy"
        />
        
        {/* Media type badge */}
        <span className="absolute top-2 left-2 px-1.5 py-0.5 bg-black/70 backdrop-blur-sm text-[10px] font-semibold uppercase text-white rounded border border-white/10">
          {mediaType === 'tv' ? 'Series' : 'Movie'}
        </span>

        {/* Rating badge on poster */}
        {voteAverage && (
          <span className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-amber-400/90 px-2 py-1 text-[11px] font-black text-black shadow-lg">
            <Star className="w-3 h-3 fill-current" />
            {voteAverage}
          </span>
        )}

        {/* Netflix-style hover overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 z-10">
          <div className="absolute bottom-0 left-0 right-0 p-4">
            {/* Title and metadata */}
            <h3 className="text-white font-bold text-base sm:text-lg line-clamp-1 mb-2">{movie.title}</h3>
            
            {/* Metadata row */}
            <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
              <span className="font-semibold text-white bg-black/50 px-2 py-0.5 rounded border border-white/10">{releaseYear}</span>
              {runtime && (
                <span className="flex items-center gap-1 text-zinc-300 bg-black/50 px-2 py-0.5 rounded border border-white/10">
                  <Clock className="w-3 h-3" />
                  {runtime}
                </span>
              )}
              {voteAverage && (
                <span className="flex items-center gap-1 text-amber-400 font-semibold bg-black/50 px-2 py-0.5 rounded border border-amber-400/30">
                  <Star className="w-3 h-3 fill-current" />
                  {voteAverage}
                </span>
              )}
            </div>

            {/* Genre pills */}
            {genres.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-3">
                {genres.slice(0, 3).map((genre, idx) => (
                  <span key={idx} className="text-[10px] text-zinc-300 bg-black/60 px-2 py-0.5 rounded-full border border-white/10">
                    {genre}
                  </span>
                ))}
                {genres.length > 3 && (
                  <span className="text-[10px] text-zinc-500 bg-black/60 px-2 py-0.5 rounded-full border border-white/10">
                    +{genres.length - 3} more
                  </span>
                )}
              </div>
            )}

            {/* Synopsis preview */}
            {synopsis && (
              <p className="text-sm text-zinc-300 line-clamp-2 mb-3 max-h-[3.5rem] overflow-hidden">
                {synopsis}
              </p>
            )}

            {/* Action buttons */}
            <div className="flex gap-2">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSave();
                }}
                className="flex-1 py-2.5 bg-white text-black font-semibold rounded-lg flex items-center justify-center gap-2 text-sm hover:bg-red-600 hover:text-white transition-all duration-200 active:scale-[0.98]"
              >
                <Play className="w-4 h-4 fill-current" />
                {saved ? 'In My List' : 'Play'}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSave();
                }}
                className="px-4 py-2.5 bg-black/50 text-white font-semibold rounded-lg flex items-center justify-center gap-2 text-sm border border-white/20 hover:bg-white/10 hover:border-white/40 transition-all duration-200"
              >
                {saved ? (
                  <Check className="w-4 h-4" />
                ) : (
                  <Bookmark className="w-4 h-4" />
                )}
                <span className="hidden sm:inline">{saved ? 'Saved' : 'Save'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
};