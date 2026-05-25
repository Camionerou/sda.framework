-- Wave 0: pgmq queues activas
-- Spec ref: §2 pgmq queues

select pgmq.create('q_extract_structure');
select pgmq.create('q_summarize_node');
select pgmq.create('q_finalize');
