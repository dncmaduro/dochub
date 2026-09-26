-- Search-only normalization; Node.normalizedName remains the uniqueness key.
CREATE FUNCTION public.search_unaccent(input text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT public.unaccent('public.unaccent', input) $$;

CREATE INDEX "Node_active_searchName_trgm_idx"
ON "Node" USING GIN (public.search_unaccent(lower("name")) gin_trgm_ops)
WHERE "trashOperationId" IS NULL;
