CREATE TABLE `videoAssets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`movieId` varchar(128) NOT NULL,
	`provider` enum('youtube') NOT NULL,
	`providerVideoId` varchar(128) NOT NULL,
	`type` varchar(64) NOT NULL,
	`name` varchar(512) NOT NULL,
	`official` int NOT NULL DEFAULT 0,
	`language` varchar(16),
	`country` varchar(16),
	`thumbnailUrl` text,
	`publishedAt` timestamp,
	`duration` int,
	`embedUrl` text NOT NULL,
	`sourceUrl` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `videoAssets_id` PRIMARY KEY(`id`),
	CONSTRAINT `videoAssets_movie_provider_video_unique` UNIQUE(`movieId`,`provider`,`providerVideoId`)
);
--> statement-breakpoint
CREATE INDEX `videoAssets_movie_id_idx` ON `videoAssets` (`movieId`);