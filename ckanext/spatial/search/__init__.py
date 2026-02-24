import json
import logging

import shapely.geometry

try:
    from shapely.errors import GeometryTypeError
    GeometryError = (GeometryTypeError, TypeError)
except ImportError:
    # Previous version of shapely uses ValueError and TypeError
    GeometryError = (ValueError, TypeError)

from ckantoolkit import config, asbool
from ckanext.spatial.lib import normalize_bbox, fit_bbox, fit_linear_ring

log = logging.getLogger(__name__)

_BBOX_PRECISION = 6

# Tolerance used when matching indexed bbox values against a search query.
# Indexed values may differ from the original coordinates by up to ~0.00001
# degrees due to Shapely float64→float32 truncation in Solr, and users
# routinely enter fewer decimal places than the stored value.
# 0.0001 degrees ≈ 11 m — small enough to distinguish genuinely different
# bounding boxes, large enough to absorb precision noise and 4-d.p. input.

# When a dataset is saved, its bounding box coordinates get slightly altered by Python and Solr's internal number handling — for example, 85.056152 might be stored as 85.05615. So when a user searches with "Exact" match and types 85.0562, it won't find the dataset because the numbers don't match perfectly. To fix this, the exact search now looks for datasets within a tiny ±0.0001° window (about 11 metres) around the entered coordinates — close enough to catch these rounding differences, but tight enough not to match genuinely different locations. Result ordering differs between modes: Intersect ranks results by how much each dataset overlaps the searched area (best overlap first), while Exact only filters datasets in or out with no overlap scoring, so results fall back to most recently updated first.
_BBOX_EXACT_TOLERANCE = 0.0001


def _round_bbox(bbox):
    """Round bbox values to _BBOX_PRECISION to remove Shapely float noise.

    Shapely's .bounds can produce values like 85.05615199999999 from an
    input of 85.056152.  Rounding to 6 d.p. before storing keeps indexed
    values clean and close to the original coordinates without discarding
    meaningful precision.
    """
    return {k: round(v, _BBOX_PRECISION) for k, v in bbox.items()}


class SpatialSearchBackend:
    """Base class for all datastore backends."""

    def process_spatial_field(self, geom_from_metadata):
        """Process spatial field based on its format (dict with spatial_type or GeoJSON string)"""
        # if string then convert to dict
        if isinstance(geom_from_metadata, str):
            geom_from_metadata = dict(json.loads(geom_from_metadata))

        # Handle dict format with spatial_type
        if isinstance(geom_from_metadata, dict):
            spatial_type = geom_from_metadata.get("spatial_type")
            value = geom_from_metadata.get("value")
            
            if spatial_type == "bbox" and value:
                # Convert bbox array to GeoJSON polygon.
                # Expected array order: [N, S, E, W]
                #   i.e. [maxy, miny, maxx, minx]
                #   e.g. [27.732161, 27.391278, 86.088867, 85.056152]
                # Note: this is different from the ext_bbox search parameter
                # which uses the standard GeoJSON order [W, S, E, N].
                if len(value) == 4:
                    maxy, miny, maxx, minx = value
                    geometry = {
                        "type": "Polygon",
                        "coordinates": [[
                            [minx, miny],
                            [maxx, miny],
                            [maxx, maxy],
                            [minx, maxy],
                            [minx, miny]
                        ]]
                    }
                    return geometry
                else:
                    log.error("Invalid bbox format, expected 4 values, not indexing :: {}".format(value))
                    return None
            
            elif spatial_type == "wkt" and value:
                # Convert WKT to GeoJSON using shapely
                try:
                    from shapely import wkt as shapely_wkt
                    shape = shapely_wkt.loads(value.strip())
                    # Convert shapely geometry to GeoJSON-like dict
                    geometry = shapely.geometry.mapping(shape)
                    return geometry
                except Exception as e:
                    log.error("Failed to parse WKT geometry: {}, not indexing :: {}".format(e, value[:100]))
                    return None
            else:
                log.error("Unknown spatial_type or missing value: {}".format(spatial_type))
                return None
        # Handle existing GeoJSON string format
        return self.parse_geojson(geom_from_metadata)

    def parse_geojson(self, geom_from_metadata):

        try:
            geometry = json.loads(geom_from_metadata)
        except (AttributeError, ValueError) as e:
            log.error(
                "Geometry not valid JSON {}, not indexing :: {}".format(
                    e, geom_from_metadata[:100]
                )
            )
            return None

        return geometry

    def shape_from_geometry(self, geometry):
        try:
            shape = shapely.geometry.shape(geometry)
        except GeometryError as e:
            log.error("{}, not indexing :: {}".format(e, json.dumps(geometry)[:100]))
            return None

        return shape


class SolrBBoxSearchBackend(SpatialSearchBackend):
    def index_dataset(self, dataset_dict):
        """
        We always index the envelope of the geometry regardless of
        if it's an actual bounding box (polygon)
        """

        geom_from_metadata = dataset_dict.get("spatial")

        if not geom_from_metadata:
            return dataset_dict

        geometry = self.process_spatial_field(geom_from_metadata)
        
        if not geometry:
            return dataset_dict
        
        shape = self.shape_from_geometry(geometry)

        if not shape:
            return dataset_dict

        bounds = shape.bounds

        bbox = normalize_bbox(list(bounds))
        if not bbox:
            return dataset_dict

        bbox = _round_bbox(bbox)
        dataset_dict.update(bbox)

        return dataset_dict

    def search_params(self, bbox, search_params, spatial_type="intersect"):
        """
        Applies a spatial filter using the indexed minx/miny/maxx/maxy fields.

        spatial_type:
          "intersect" (default) - dataset bbox must overlap with the query bbox,
                                  scored by degree of overlap via a boost function
          "exact"               - dataset bbox must exactly equal the query bbox,
                                  no scoring, no frange
        """
        bbox = dict(bbox)
        while bbox["minx"] < -180:
            bbox["minx"] += 360
            bbox["maxx"] += 360
        while bbox["minx"] > 180:
            bbox["minx"] -= 360
            bbox["maxx"] -= 360

        search_params.setdefault("fq_list", [])

        if spatial_type == "exact":
            # Use a small tolerance range instead of strict equality so that
            # minor float precision differences (Shapely → Solr float32) and
            # users entering fewer decimal places all resolve to a match.
            # e.g. stored 85.05615, search 85.056152 or 85.0562 all hit
            # the range [85.0561 TO 85.0563].
            eps = _BBOX_EXACT_TOLERANCE
            search_params["fq_list"].append(
                f"minx:[{bbox['minx'] - eps} TO {bbox['minx'] + eps}]"
                f" AND miny:[{bbox['miny'] - eps} TO {bbox['miny'] + eps}]"
                f" AND maxx:[{bbox['maxx'] - eps} TO {bbox['maxx'] + eps}]"
                f" AND maxy:[{bbox['maxy'] - eps} TO {bbox['maxy'] + eps}]"
            )
        else:
            minx = bbox["minx"]
            maxx = bbox["maxx"]
            miny = bbox["miny"]
            maxy = bbox["maxy"]
            area_search = abs(maxx - minx) * abs(maxy - miny)


            bf = (
                f"div("
                f"mul(mul(max(0,sub(min({maxx},maxx),max({minx},minx))),"
                f"max(0,sub(min({maxy},maxy),max({miny},miny)))),2),"
                f"add({area_search},mul(sub(maxy,miny),sub(maxx,minx)))"
                f")"
            )

            search_params["fq_list"].append(f"{{!frange incl=false l=0}}{bf}")
            search_params["bf"] = bf
            search_params["defType"] = "edismax"

        return search_params


class SolrSpatialFieldSearchBackend(SpatialSearchBackend):
    def index_dataset(self, dataset_dict):
        wkt = None
        geom_from_metadata = dataset_dict.get("spatial")

        if not geom_from_metadata:
            return dataset_dict

        geometry = self.process_spatial_field(geom_from_metadata)

        if not geometry:
            return dataset_dict

        # We allow multiple geometries as GeometryCollections
        if geometry["type"] == "GeometryCollection":
            geometries = geometry["geometries"]
        else:
            geometries = [geometry]

        # Check potential problems with bboxes in each geometry
        wkt = []
        for geom in geometries:
            if (
                geom["type"] == "Polygon"
                and len(geom["coordinates"]) == 1
                and len(geom["coordinates"][0]) == 5
            ):

                # Check wrong bboxes (4 same points)
                xs = [p[0] for p in geom["coordinates"][0]]
                ys = [p[1] for p in geom["coordinates"][0]]

                if xs.count(xs[0]) == 5 and ys.count(ys[0]) == 5:
                    wkt.append("POINT({x} {y})".format(x=xs[0], y=ys[0]))
                else:
                    # Check if coordinates are defined counter-clockwise,
                    # otherwise we'll get wrong results from Solr
                    lr = shapely.geometry.polygon.LinearRing(geom["coordinates"][0])
                    lr_coords = (
                        list(lr.coords)
                        if lr.is_ccw
                        else list(reversed(list(lr.coords)))
                    )
                    polygon = shapely.geometry.polygon.Polygon(
                        fit_linear_ring(lr_coords)
                    )
                    wkt.append(polygon.wkt)

        shape = self.shape_from_geometry(geometry)

        if not wkt:
            shape = shapely.geometry.shape(geometry)
            if not shape.is_valid:
                log.error("Wrong geometry, not indexing")
                return dataset_dict
            if shape.bounds[0] < -180 or shape.bounds[2] > 180:
                log.error(
                    """
Geometries outside the -180, -90, 180, 90 boundaries are not supported,
you need to split the geometry in order to fit the parts. Not indexing"""
                )
                return dataset_dict
            wkt = shape.wkt

        dataset_dict["spatial_geom"] = wkt

        return dataset_dict

    def search_params(self, bbox, search_params):

        bbox = fit_bbox(bbox)

        if not search_params.get("fq_list"):
            search_params["fq_list"] = []

        default_spatial_query = "{{!field f=spatial_geom}}Intersects(ENVELOPE({minx}, {maxx}, {maxy}, {miny}))"

        spatial_query = config.get("ckanext.spatial.solr_query", default_spatial_query)

        search_params["fq_list"].append(
            spatial_query.format(spatial_field="spatial_geom", **bbox)
        )

        return search_params


search_backends = {
    "solr-bbox": SolrBBoxSearchBackend,
    "solr-spatial-field": SolrSpatialFieldSearchBackend,
}
