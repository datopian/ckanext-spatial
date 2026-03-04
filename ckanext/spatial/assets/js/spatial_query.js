/* Module for handling the spatial querying
 */
this.ckan.module('spatial-query', function ($, _) {

  return {
    options: {
      i18n: {
      },
      style: {
        color: '#F06F64',
        weight: 2,
        opacity: 1,
        fillColor: '#F06F64',
        fillOpacity: 0.1,
        clickable: false
      },
      default_extent: [[90, 180], [-90, -180]]
    },
    template: {
      buttons: [
        '<div id="dataset-map-edit-buttons">',
        '<a href="javascript:;" class="btn cancel">Cancel</a> ',
        '<a href="javascript:;" class="btn apply disabled">Apply</a>',
        '</div>'
      ].join(''),
      modal: {
        bootstrap3: [
          '<div class="modal">',
          '<div class="modal-dialog modal-lg">',
          '<div class="modal-content">',
          '<div class="modal-header">',
          '<button type="button" class="close" data-dismiss="modal">×</button>',
          '<h3 class="modal-title"></h3>',
          '</div>',
          '<div class="modal-body"><div id="draw-map-container"></div></div>',
          '<div class="modal-footer">',
          '<button class="btn btn-default btn-cancel" data-dismiss="modal"></button>',
          '<button class="btn apply btn-primary disabled"></button>',
          '</div>',
          '</div>',
          '</div>',
          '</div>'
        ].join('\n'),
        bootstrap5: [
          '<div class="modal" tabindex="-1">',
          '<div class="modal-dialog modal-lg modal-spatial-query">',
          '<div class="modal-content">',
          '<div class="modal-header">',
          '<h4 class="modal-title"></h4>',
          '<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>',
          '</div>',
          '<div class="modal-body"><div id="draw-map-container"></div></div>',
          '<div class="modal-footer">',
          '<button type="button" class="btn btn-secondary btn-cancel" data-bs-dismiss="modal"></button>',
          '<button type="button" class="btn btn-primary apply disabled"></button>',
          '</div>',
          '</div>',
          '</div>',
          '</div>'
        ].join('\n')
      }
    },

    initialize: function () {
      var module = this;
      $.proxyAll(this, /_on/);

      var user_default_extent = this.el.data('default_extent');
      if (user_default_extent ){
        if (user_default_extent instanceof Array) {
          // Assume it's a pair of coords like [[90, 180], [-90, -180]]
          this.options.default_extent = user_default_extent;
        } else if (user_default_extent instanceof Object) {
          // Assume it's a GeoJSON bbox
          this.options.default_extent = new L.GeoJSON(user_default_extent).getBounds();
        }
      }
      this.el.ready(this._onReady);
    },

    _getBootstrapVersion: function () {
      return $.fn.modal.Constructor.VERSION.split(".")[0];
    },

    _createModal: function () {
      if (!this.modal) {
        var element = this.modal = jQuery(this.template.modal["bootstrap" + this._getBootstrapVersion()]);
        element.on('click', '.btn-primary', this._onApply);
        element.on('click', '.btn-cancel', this._onCancel);
        element.modal({show: false});

        element.find('.modal-title').text(this._('Please draw query extent in the map:'));
        element.find('.btn-primary').text(this._('Apply'));
        element.find('.btn-cancel').text(this._('Cancel'));

        var module = this;

        this.modal.on('shown.bs.modal', function () {
          if (module.drawMap) {
            module._setPreviousBBBox(map, zoom=false);
            map.fitBounds(module.mainMap.getBounds());

            $('a.leaflet-draw-draw-rectangle>span', element).trigger('click');
            return
          }
          var container = element.find('#draw-map-container')[0];
          module.drawMap = map = module._createMap(container);

          // Initialize the draw control
          var draw = new L.Control.Draw({
            position: 'topright',
            draw: {
              polyline: false,
              polygon: false,
              circle: false,
              circlemarker: false,
              marker: false,
              rectangle: {shapeOptions: module.options.style}
            }
          });

          map.addControl(draw);

          module._setPreviousBBBox(map, zoom=false);
          map.fitBounds(module.mainMap.getBounds());

          if (map.getZoom() == 0) {
            map.zoomIn();
          }

          map.on('draw:created', function (e) {
            if (module.extentLayer) {
              map.removeLayer(module.extentLayer);
            }
            var bounds = e.layer.getBounds();
            module.extentLayer = extentLayer = module._drawExtentFromCoords(bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth());
            var west  = Math.max(-180, Math.min(180, bounds.getWest()));
            var south = Math.max(-90,  Math.min(90,  bounds.getSouth()));
            var east  = Math.max(-180, Math.min(180, bounds.getEast()));
            var north = Math.max(-90,  Math.min(90,  bounds.getNorth()));
            var bbox_string = west + ',' + south + ',' + east + ',' + north;
            module.ext_bbox_input.val(bbox_string);
            module._updateBboxInputs(bbox_string);
            map.addLayer(extentLayer);
            element.find('.btn-primary').removeClass('disabled').addClass('btn-primary');
          });

          $('a.leaflet-draw-draw-rectangle>span', element).trigger('click');
          element.find('.btn-primary').focus()
        })

        this.modal.on('hidden.bs.modal', function () {
          module._onCancel()
        });

      }
      return this.modal;
    },

    _getParameterByName: function (name) {
      var match = RegExp('[?&]' + name + '=([^&]*)')
                        .exec(window.location.search);
      return match ?
          decodeURIComponent(match[1].replace(/\+/g, ' '))
          : null;
    },

    _drawExtentFromCoords: function(xmin, ymin, xmax, ymax) {
        if ($.isArray(xmin)) {
            var coords = xmin;
            xmin = coords[0]; ymin = coords[1]; xmax = coords[2]; ymax = coords[3];
        }
        return new L.Rectangle([[ymin, xmin], [ymax, xmax]],
                               this.options.style);
    },

    _drawExtentFromGeoJSON: function(geom) {
        return new L.GeoJSON(geom, {style: this.options.style});
    },

    _onApply: function() {
      $(".search-form").submit();
    },

    _onCancel: function() {
      if (this.extentLayer) {
        this.drawMap.removeLayer(this.extentLayer);
      }
    },

    _createMap: function(container) {
      map = ckan.commonLeafletMap(
        container,
        this.options.map_config,
        {
          attributionControl: false,
          drawControlTooltips: false
        }
      );

      return map;

    },

    _validateBboxInputs: function() {
      var west  = parseFloat($('#bbox-west').val());
      var south = parseFloat($('#bbox-south').val());
      var east  = parseFloat($('#bbox-east').val());
      var north = parseFloat($('#bbox-north').val());

      $('.bbox-input').removeClass('bbox-input--invalid');
      $('#bbox-validation-error').hide().text('');

      var missing = isNaN(west) || isNaN(south) || isNaN(east) || isNaN(north);
      if (missing) {
        if (isNaN(west))  $('#bbox-west').addClass('bbox-input--invalid');
        if (isNaN(south)) $('#bbox-south').addClass('bbox-input--invalid');
        if (isNaN(east))  $('#bbox-east').addClass('bbox-input--invalid');
        if (isNaN(north)) $('#bbox-north').addClass('bbox-input--invalid');
        $('#bbox-validation-error').text('All four coordinates are required.').show();
        return null;
      }
      if (west < -180 || west > 180) {
        $('#bbox-west').addClass('bbox-input--invalid');
        $('#bbox-validation-error').text('West must be between \u2212180 and 180.').show();
        return null;
      }
      if (east < -180 || east > 180) {
        $('#bbox-east').addClass('bbox-input--invalid');
        $('#bbox-validation-error').text('East must be between \u2212180 and 180.').show();
        return null;
      }
      if (south < -90 || south > 90) {
        $('#bbox-south').addClass('bbox-input--invalid');
        $('#bbox-validation-error').text('South must be between \u221290 and 90.').show();
        return null;
      }
      if (north < -90 || north > 90) {
        $('#bbox-north').addClass('bbox-input--invalid');
        $('#bbox-validation-error').text('North must be between \u221290 and 90.').show();
        return null;
      }
      if (west >= east) {
        $('#bbox-west, #bbox-east').addClass('bbox-input--invalid');
        $('#bbox-validation-error').text('West must be less than East.').show();
        return null;
      }
      if (south >= north) {
        $('#bbox-south, #bbox-north').addClass('bbox-input--invalid');
        $('#bbox-validation-error').text('South must be less than North.').show();
        return null;
      }
      return {west: west, south: south, east: east, north: north};
    },

    _updateBboxInputs: function(bbox_string) {
      if (!bbox_string) {
        $('#bbox-west, #bbox-south, #bbox-east, #bbox-north').val('');
        return;
      }
      var parts = bbox_string.split(',');
      if (parts.length === 4) {
        $('#bbox-west').val(parseFloat(parts[0]).toFixed(4));
        $('#bbox-south').val(parseFloat(parts[1]).toFixed(4));
        $('#bbox-east').val(parseFloat(parts[2]).toFixed(4));
        $('#bbox-north').val(parseFloat(parts[3]).toFixed(4));
      }
    },

    // Is there an existing box from a previous search?
    _setPreviousBBBox: function(map, zoom=true) {
      let module = this;
      previous_bbox = module._getParameterByName('ext_bbox');
      if (previous_bbox) {
        module.ext_bbox_input.val(previous_bbox);
        module.extentLayer = module._drawExtentFromCoords(previous_bbox.split(','))
        map.addLayer(module.extentLayer);
        if (zoom) {
          map.fitBounds(module.extentLayer.getBounds(), {"animate": false, "padding": [20, 20]});
        }
      } else {
        map.fitBounds(module.options.default_extent, {"animate": false});
      }
    },

    _onReady: function() {
      let module = this;
      let map;
      let form = $('#dataset-search-form');
      let bbox_input_id = 'ext_bbox';

      // Add necessary field to the search form if not already created
      if ($("#" + bbox_input_id).length === 0) {
        $('<input type="hidden" />').attr({'id': bbox_input_id, 'name': bbox_input_id}).appendTo(form);
      }
      module.ext_bbox_input = $('#dataset-search-form #ext_bbox');

      // Add spatial type field to the search form
      if ($("#ext_search_type").length === 0) {
        $('<input type="hidden" />').attr({'id': 'ext_search_type', 'name': 'ext_search_type'}).appendTo(form);
      }
      module.ext_search_type_input = $('#dataset-search-form #ext_search_type');

      // OK map time
      this.mainMap = map = this._createMap('dataset-map-container');

      var expandButton = L.Control.extend({
        position: 'topright',
        onAdd: function(map) {
          var container = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-custom');

          var button = L.DomUtil.create('a', 'leaflet-control-custom-button', container);
          button.innerHTML = '<i class="fa fa-pencil"></i>';
          button.title = module._('Draw an extent');

          L.DomEvent.on(button, 'click', function(e) {
            module.sandbox.body.append(module._createModal());
            module.modal.modal('show');

          });

          return container;
        }
      });
      map.addControl(new expandButton());

      module._setPreviousBBBox(map);

      // Sync manual inputs from URL params
      module._updateBboxInputs(module.ext_bbox_input.val());
      var existing_type = module._getParameterByName('ext_search_type');
      if (existing_type) {
        module.ext_search_type_input.val(existing_type);
        $('#bbox-spatial-type').val(existing_type);
      }

      // Spatial type help text
      var typeHelp = {
        intersect: 'Returns datasets that overlap or intersect with the specified coordinate even partially.',
        exact: 'Returns datasets whose coordinate exactly matches the specified coordinates.'
      };
      function updateTypeHelp() {
        var text = typeHelp[$('#bbox-spatial-type').val()] || '';
        $('#bbox-type-help-text').text(text);
        $('#bbox-type-help').css('display', text ? 'flex' : 'none');
      }
      $('#bbox-spatial-type').on('change', updateTypeHelp);
      updateTypeHelp();

      // Collapsible bbox panel
      var COLLAPSE_KEY = 'ckan_spatial_bbox_collapsed';
      var bboxBody = $('#bbox-body');
      var bboxToggle = $('#bbox-toggle');
      var bboxCollapsed = localStorage.getItem(COLLAPSE_KEY) === '1';
      if (bboxCollapsed) {
        bboxBody.hide();
        bboxToggle.attr('aria-expanded', 'false').addClass('bbox-toggle-bar--collapsed');
      }
      bboxToggle.on('click', function() {
        bboxCollapsed = !bboxCollapsed;
        localStorage.setItem(COLLAPSE_KEY, bboxCollapsed ? '1' : '0');
        bboxBody.slideToggle(150);
        bboxToggle.attr('aria-expanded', bboxCollapsed ? 'false' : 'true')
                  .toggleClass('bbox-toggle-bar--collapsed', bboxCollapsed);
      });

      // Clear validation state when user edits any coordinate input
      $(document).on('input', '.bbox-input', function() {
        $(this).removeClass('bbox-input--invalid');
        if (!$('.bbox-input--invalid').length) {
          $('#bbox-validation-error').hide().text('');
        }
      });

      // Apply button: validate then build bbox and submit
      $('#bbox-apply').on('click', function() {
        var coords = module._validateBboxInputs();
        if (!coords) return;

        var bbox_string = coords.west + ',' + coords.south + ',' + coords.east + ',' + coords.north;
        module.ext_bbox_input.val(bbox_string);
        module.ext_search_type_input.val($('#bbox-spatial-type').val());

        // Draw on the main map
        if (module.extentLayer) {
          module.mainMap.removeLayer(module.extentLayer);
        }
        module.extentLayer = module._drawExtentFromCoords(coords.west, coords.south, coords.east, coords.north);
        module.mainMap.addLayer(module.extentLayer);
        module.mainMap.fitBounds(module.extentLayer.getBounds(), {padding: [10, 10]});

        $(".search-form").submit();
      });

      // Clear button: wipe everything and re-submit
      $('#bbox-clear').on('click', function() {
        $('#bbox-west, #bbox-south, #bbox-east, #bbox-north').val('').removeClass('bbox-input--invalid');
        $('#bbox-validation-error').hide().text('');
        $('#bbox-spatial-type').val('intersect');
        module.ext_bbox_input.val('');
        module.ext_search_type_input.val('');
        if (module.extentLayer) {
          module.mainMap.removeLayer(module.extentLayer);
          module.extentLayer = null;
        }
        $(".search-form").submit();
      });

    }
  }
});
