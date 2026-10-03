-- A unique token is assigned on every claim.  It fences a worker that resumes
-- after its lease has expired and another worker has reclaimed the task.
ALTER TABLE "FileProcessingTask"
  ADD COLUMN "leaseToken" UUID;
