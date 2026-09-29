CREATE SCHEMA IF NOT EXISTS svoe_vino;

DO $$
BEGIN
    IF to_regclass('public.wines') IS NOT NULL THEN
        ALTER TABLE public.wines SET SCHEMA svoe_vino;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.grapes') IS NOT NULL THEN
        ALTER TABLE public.grapes SET SCHEMA svoe_vino;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.dishes') IS NOT NULL THEN
        ALTER TABLE public.dishes SET SCHEMA svoe_vino;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.wine_grapes') IS NOT NULL THEN
        ALTER TABLE public.wine_grapes SET SCHEMA svoe_vino;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.wine_dishes') IS NOT NULL THEN
        ALTER TABLE public.wine_dishes SET SCHEMA svoe_vino;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.crawl_pages') IS NOT NULL THEN
        ALTER TABLE public.crawl_pages SET SCHEMA svoe_vino;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.crawl_wines') IS NOT NULL THEN
        ALTER TABLE public.crawl_wines SET SCHEMA svoe_vino;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.wine_images') IS NOT NULL THEN
        ALTER TABLE public.wine_images SET SCHEMA svoe_vino;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.wine_rating_snapshots') IS NOT NULL THEN
        ALTER TABLE public.wine_rating_snapshots SET SCHEMA svoe_vino;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.wine_external_matches') IS NOT NULL THEN
        ALTER TABLE public.wine_external_matches SET SCHEMA svoe_vino;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.wine_barcodes') IS NOT NULL THEN
        ALTER TABLE public.wine_barcodes SET SCHEMA svoe_vino;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.recognition_profiles') IS NOT NULL THEN
        ALTER TABLE public.recognition_profiles SET SCHEMA svoe_vino;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.recognition_aliases') IS NOT NULL THEN
        ALTER TABLE public.recognition_aliases SET SCHEMA svoe_vino;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.recognition_assets') IS NOT NULL THEN
        ALTER TABLE public.recognition_assets SET SCHEMA svoe_vino;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.recognition_annotations') IS NOT NULL THEN
        ALTER TABLE public.recognition_annotations SET SCHEMA svoe_vino;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.ocr_observations') IS NOT NULL THEN
        ALTER TABLE public.ocr_observations SET SCHEMA svoe_vino;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.visual_features') IS NOT NULL THEN
        ALTER TABLE public.visual_features SET SCHEMA svoe_vino;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.asset_processing_jobs') IS NOT NULL THEN
        ALTER TABLE public.asset_processing_jobs SET SCHEMA svoe_vino;
    END IF;
END $$;

DROP SCHEMA IF EXISTS public;