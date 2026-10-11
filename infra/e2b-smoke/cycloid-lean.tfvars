prefix        = "arc-e2b-smoke-"
bucket_prefix = "arc-e2b-smoke-666177270058-"
domain_name   = "cycloid-e2b-dev.com"
environment   = "dev"

control_server_cluster_size = 1
control_server_machine_type = "t3.medium"

api_cluster_size         = 1
api_server_machine_type  = "t3.large"
api_cpu_count            = 0.5
api_internal_grpc_port   = 5009
ingress_count            = 1
ingress_cpu_count        = 0.5
client_proxy_count       = 1
client_proxy_cpu_count   = 0.5
loki_cpu_count           = 0.5
otel_collector_cpu_count = 0.25

client_cluster_size        = 1
client_server_machine_type = "m8i.2xlarge"

build_cluster_size        = 0
build_server_machine_type = "m8i.2xlarge"

clickhouse_cluster_size        = 1
clickhouse_server_machine_type = "t3.medium"
clickhouse_cpu_count           = 1
clickhouse_memory_mb           = 2048

redis_managed = false

db_max_open_connections      = 20
db_min_idle_connections      = 2
auth_db_max_open_connections = 10
auth_db_min_idle_connections = 2
