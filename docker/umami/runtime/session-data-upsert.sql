insert into session_data (
  session_data_id,
  website_id,
  session_id,
  data_key,
  string_value,
  number_value,
  date_value,
  data_type,
  distinct_id,
  created_at
)
values (
  {{id}},
  {{websiteId}},
  {{sessionId}},
  {{dataKey}},
  {{stringValue}},
  {{numberValue}},
  {{dateValue}},
  {{dataType}},
  {{distinctId}},
  coalesce({{createdAt}}, now())
)
on conflict (session_id, data_key)
do update set
  website_id = excluded.website_id,
  string_value = excluded.string_value,
  number_value = excluded.number_value,
  date_value = excluded.date_value,
  data_type = excluded.data_type,
  distinct_id = excluded.distinct_id,
  created_at = coalesce({{createdAt}}, session_data.created_at)
