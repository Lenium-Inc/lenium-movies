import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Filter, X, Sparkles, Check } from 'lucide-react';
import { genreFilterOptions } from '@/hooks/useCatalog';
import type { View } from '@/components/layout/navigation';

interface DiscoverDropdownProps {
  genre: string;
  setGenre: (genre: string) => void;
  setView: (view: View) => void;
  filteredCount: number;
  isLoading: boolean;
}

export const DiscoverDropdown: React.FC<DiscoverDropdownProps> = ({
  genre,
  setGenre,
  setView,
  filteredCount,
  isLoading,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedGenre, setSelectedGenre] = useState(genre || 'All');
  const [selectedSort, setSelectedSort] = useState('Trending');
  const [selectedType, setSelectedType] = useState('All');
  
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        if (triggerRef.current && triggerRef.current.contains(event.target as Node)) {
          return;
        }
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const genres = genreFilterOptions;
  const sortOptions = ['Trending', 'Top Rated', 'Release Year', 'Most Popular'];
  const types = ['All', 'Movie', 'TV Show'];

  const handleApply = () => {
    setSelectedGenre(selectedGenre);
    setGenre(selectedGenre);
    setView('movies');
    setIsOpen(false);
  };

  const hasActiveFilters = selectedGenre !== 'All' || selectedSort !== 'Trending' || selectedType !== 'All';

  return (
    <div className="relative inline-block text-left z-40" ref={dropdownRef}>
      <button
        ref={triggerRef}
        onClick={() => setIsOpen(!isOpen)}
        className="flex shrink-0 items-center justify-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-4 py-2.5 text-xs font-semibold text-[#c4c4c0] transition hover:border-white/25 hover:bg-white/5 hover:text-white"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
      >
        <Filter className="h-4 w-4" />
        <span>Discover</span>
        <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute left-0 mt-2 w-80 bg-zinc-950 border border-white/10 rounded-2xl shadow-2xl overflow-hidden p-5 flex flex-col gap-4 animate-in fade-in slide-in-from-top-2 duration-150">
          <div className="flex items-center justify-between border-b border-white/10 pb-3">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-red-500" />
              <span className="text-white font-semibold text-sm">Filter Catalog</span>
            </div>
            <button 
              onClick={() => setIsOpen(false)}
              className="text-zinc-400 hover:text-white transition-colors p-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Type Filter */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Type</label>
            <div className="grid grid-cols-3 gap-1.5">
              {types.map((t) => (
                <button
                  key={t}
                  onClick={() => setSelectedType(t)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${selectedType === t ? 'bg-red-600 text-white font-semibold' : 'bg-zinc-900 text-zinc-300 hover:bg-zinc-800'}`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Genre Selection */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Genre</label>
            <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto pr-1">
              {genres.map((g) => (
                <button
                  key={g}
                  onClick={() => setSelectedGenre(g)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${selectedGenre === g ? 'bg-white text-black font-semibold' : 'bg-zinc-900 text-zinc-300 hover:bg-zinc-800'}`}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>

          {/* Sort By Selection */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Sort By</label>
            <div className="grid grid-cols-2 gap-1.5">
              {sortOptions.map((s) => (
                <button
                  key={s}
                  onClick={() => setSelectedSort(s)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium text-left transition-all flex items-center justify-between ${selectedSort === s ? 'bg-zinc-800 text-white border border-white/20' : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'}`}
                >
                  <span>{s}</span>
                  {selectedSort === s && <Check className="w-3 h-3 text-red-500" />}
                </button>
              ))}
            </div>
          </div>

          {/* Apply Filters Button */}
          <button
            onClick={handleApply}
            className="mt-2 w-full py-2.5 bg-red-600 hover:bg-red-500 text-white font-semibold rounded-xl text-xs tracking-wide transition-all shadow-lg"
          >
            Apply Filters
          </button>

          {/* Results summary */}
          <div className="pt-3 border-t border-white/10 flex items-center justify-between text-xs text-zinc-500">
            <span>
              {isLoading ? (
                'Loading...'
              ) : filteredCount === 0 ? (
                'No matches found'
              ) : (
                `${filteredCount} title${filteredCount !== 1 ? 's' : ''} found`
              )}
            </span>
            {hasActiveFilters && (
              <button
                onClick={() => {
                  setSelectedGenre('All');
                  setSelectedSort('Trending');
                  setSelectedType('All');
                }}
                className="text-red-400 hover:text-red-300 underline"
              >
                Clear all
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};