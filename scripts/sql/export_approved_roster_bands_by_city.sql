select
  city,
  name as approved_band_name
from public.bands
order by city, approved_band_name;
