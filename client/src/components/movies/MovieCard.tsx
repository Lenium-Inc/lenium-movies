import { Star, Play } from 'lucide-react';
import type { Movie } from './types';

interface MovieCardProps {
  movie: Movie;
  saved?: boolean;
  onSelect: () => void;
  onSave: () => void;
}

export const MovieCard: React.FC<MovieCardProps> = ({ movie, saved, onSelect, onSave }) => {
  const posterUrl = movie.poster || `https://via.placeholder.com/500x750?text=${encodeURIComponent(movie.title)}`;
  const releaseYear = movie.year?.toString() || 'Unknown';
  const voteAverage = movie.score?.toFixed(1) || '—';
  const genres = movie.genre || [];
  const mediaType = movie.mediaType || 'movie';

  return (
    <div
      onClick={onSelect}
      className="group relative bg-zinc-900 rounded-xl overflow-hidden shadow-lg cursor-pointer transform transition-all duration-300 hover:scale-105 hover:z-20 hover:shadow-2xl border border-white/5"
    >
      <div className="aspect-[2/3] w-full overflow-hidden bg-zinc-800">
        <img
          src={posterUrl}
          alt={movie.title}
          className="w-full h-full object-cover group-hover:opacity-90 transition-opacity"
          loading="lazy"
        />
      </div>

      {/* Netflix Style Hover Overlay Details */}
      <div className="absolute inset-x-0 bottom-0 p-4 bg-gradient-to-t from-black via-black/80 to-transparent flex flex-col justify-end opacity-0 group-hover:opacity-100 transition-opacity duration-300">
        <h3 className="text-white font-bold text-sm line-clamp-1">{movie.title}</h3>

        <div className="flex items-center gap-2 mt-1.5 text-xs text-zinc-300">
          <span className="font-semibold text-white">{releaseYear}</span>
          <span className="px-1.5 py-0.5 bg-white/10 rounded text-[10px] uppercase font-mono">{mediaType}</span>
          <div className="flex items-center gap-1 text-amber-400 font-semibold ml-auto">
            <Star className="w-3.5 h-3.5 fill-current" />
            <span>{voteAverage}</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-1 mt-2">
          {genres?.slice(0, 2).map((genre, idx) => (
            <span key={idx} className="text-[10px] text-zinc-400 bg-zinc-800/80 px-2 py-0.5 rounded-full">
              {genre}
            </span>
          ))}
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onSave();
          }}
          className="mt-3 w-full py-2 bg-white text-black font-semibold rounded-lg flex items-center justify-center gap-2 text-xs hover:bg-red-600 hover:text-white transition-colors"
        >
          <Play className="w-3.5 h-3.5 fill-current" />
          {saved ? 'In My List' : 'Play Now'}
        </button>
      </div>
    </div>
  );
};