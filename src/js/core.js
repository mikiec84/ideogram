// Developed by Eric Weitz (https://github.com/eweitz)

import * as d3selection from 'd3-selection';
// See https://github.com/d3/d3/issues/2733
import {event as currentEvent} from 'd3-selection';
import * as d3request from 'd3-request';
import * as d3brush from 'd3-brush';
import * as d3dispatch from 'd3-dispatch';
import * as d3promise from 'd3.promise';
import {Promise} from 'es6-promise';

import {Ploidy} from './ploidy';
import {Layout} from './layouts/layout';
import {ModelAdapter} from './model-adapter';
import {Chromosome} from './views/chromosome';
import version from './version';

var d3 = Object.assign({}, d3selection, d3request, d3brush, d3dispatch);
d3.promise = d3promise;

import {
  onDrawAnnots, processAnnotData, initAnnotSettings, fetchAnnots, drawAnnots,
  getHistogramBars, fillAnnots, drawProcessedAnnots
} from './annotations';

import {
  eutils, esearch, esummary, elink,
  getTaxidFromEutils, getOrganismFromEutils, getTaxids,
  getAssemblyAndChromosomesFromEutils
} from './services'


export default class Ideogram {
  constructor(config) {
    var orientation,
      chrWidth, chrHeight,
      container, rect;

    // Clone the config object, to allow multiple instantiations
    // without picking up prior ideogram's settings
    this.config = JSON.parse(JSON.stringify(config));

    // Functions from annotations.js
    this.onDrawAnnots = onDrawAnnots;
    this.processAnnotData = processAnnotData;
    this.initAnnotSettings = initAnnotSettings;
    this.fetchAnnots = fetchAnnots;
    this.drawAnnots = drawAnnots;
    this.getHistogramBars = getHistogramBars;
    this.fillAnnots = fillAnnots;
    this.drawProcessedAnnots = drawProcessedAnnots;

    // Variables and functions from services.js
    this.eutils = eutils;
    this.esearch = esearch;
    this.esummary = esummary;
    this.elink = elink;
    this.getTaxidFromEutils = getTaxidFromEutils;
    this.getOrganismFromEutils = getOrganismFromEutils;
    this.getTaxids = getTaxids;
    this.getAssemblyAndChromosomesFromEutils = getAssemblyAndChromosomesFromEutils;

    // TODO: Document this
    this._bandsXOffset = 30;

    if (!this.config.debug) {
      this.config.debug = false;
    }

    if (!this.config.dataDir) {
      this.config.dataDir = this.getDataDir();
    }

    if (!this.config.ploidy) {
      this.config.ploidy = 1;
    }

    if (this.config.ploidy > 1) {
      this.sexChromosomes = {};
      if (!this.config.sex) {
        // Default to 'male' per human, mouse reference genomes.
        // TODO: The default sex value should probably be the heterogametic sex,
        // i.e. whichever sex has allosomes that differ in morphology.
        // In mammals and most insects that is the male.
        // However, in birds and reptiles, that is female.
        this.config.sex = 'male';
      }
      if (this.config.ploidy === 2 && !this.config.ancestors) {
        this.config.ancestors = {M: '#ffb6c1', P: '#add8e6'};
        this.config.ploidyDesc = 'MP';
      }
    }

    if (!this.config.container) {
      this.config.container = 'body';
    }

    this.selector = this.config.container + ' #_ideogram';

    if (!this.config.resolution) {
      this.config.resolution = '';
    }

    if ('showChromosomeLabels' in this.config === false) {
      this.config.showChromosomeLabels = true;
    }

    if (!this.config.orientation) {
      orientation = 'vertical';
      this.config.orientation = orientation;
    }

    if (!this.config.chrHeight) {
      container = this.config.container;
      rect = document.querySelector(container).getBoundingClientRect();

      if (orientation === 'vertical') {
        chrHeight = rect.height;
      } else {
        chrHeight = rect.width;
      }

      if (container === 'body') {
        chrHeight = 400;
      }
      this.config.chrHeight = chrHeight;
    }

    if (!this.config.chrWidth) {
      chrWidth = 10;
      chrHeight = this.config.chrHeight;

      if (chrHeight < 900 && chrHeight > 500) {
        chrWidth = Math.round(chrHeight / 40);
      } else if (chrHeight >= 900) {
        chrWidth = Math.round(chrHeight / 45);
      }
      this.config.chrWidth = chrWidth;
    }

    if (!this.config.chrMargin) {
      if (this.config.ploidy === 1) {
        this.config.chrMargin = 10;
      } else {
        // Defaults polyploid chromosomes to relatively small interchromatid gap
        this.config.chrMargin = Math.round(this.config.chrWidth / 4);
      }
    }

    if (!this.config.showBandLabels) {
      this.config.showBandLabels = false;
    }

    if ('showFullyBanded' in this.config) {
      this.config.showFullyBanded = config.showFullyBanded;
    } else {
      this.config.showFullyBanded = true;
    }

    if (!this.config.brush) {
      this.config.brush = false;
    }

    if (!this.config.rows) {
      this.config.rows = 1;
    }

    this.bump = Math.round(this.config.chrHeight / 125);
    this.adjustedBump = false;
    if (this.config.chrHeight < 200) {
      this.adjustedBump = true;
      this.bump = 4;
    }

    if (config.showBandLabels) {
      this.config.chrMargin += 20;
    }

    if (config.chromosome) {
      this.config.chromosomes = [config.chromosome];
      if ('showBandLabels' in config === false) {
        this.config.showBandLabels = true;
      }
      if ('rotatable' in config === false) {
        this.config.rotatable = false;
      }
    }

    if (!this.config.showNonNuclearChromosomes) {
      this.config.showNonNuclearChromosomes = false;
    }

    this.initAnnotSettings();

    this.config.chrMargin = (
      this.config.chrMargin +
    this.config.chrWidth +
    this.config.annotTracksHeight * 2
    );

    if (config.onLoad) {
      this.onLoadCallback = config.onLoad;
    }

    if (config.onDrawAnnots) {
      this.onDrawAnnotsCallback = config.onDrawAnnots;
    }

    if (config.onBrushMove) {
      this.onBrushMoveCallback = config.onBrushMove;
    }

    this.coordinateSystem = 'iscn';

    this.maxLength = {
      bp: 0,
      iscn: 0
    };

    this.organisms = {
      9606: {
        commonName: 'Human',
        scientificName: 'Homo sapiens',
        scientificNameAbbr: 'H. sapiens',
        assemblies: {
          default: 'GCF_000001405.26', // GRCh38
          GRCh38: 'GCF_000001405.26',
          GRCh37: 'GCF_000001405.13'
        }
      },
      10090: {
        commonName: 'Mouse',
        scientificName: 'Mus musculus',
        scientificNameAbbr: 'M. musculus',
        assemblies: {
          default: 'GCF_000001635.20'
        }
      },
      4641: {
        commonName: 'banana',
        scientificName: 'Musa acuminata',
        scientificNameAbbr: 'M. acuminata',
        assemblies: {
          default: 'mock'
        }
      }
    };

    // A flat array of chromosomes
    // (this.chromosomes is an object of
    // arrays of chromosomes, keyed by organism)
    this.chromosomesArray = [];

    this.bandsToShow = [];

    this.chromosomes = {};
    this.numChromosomes = 0;
    this.bandData = {};

    this.init();
  }

  /**
   * Get the current version of Ideogram.js
   */
  static get version() {
    return version;
  }

  /**
  * Enable use of D3 in client apps, via "d3 = Ideogram.d3"
  */
  static get d3() {
    return d3;
  }

  /**
  * e.g. "Homo sapiens" -> "homo-sapiens"
  */
  static slugify(value) {
    return value.toLowerCase().replace(' ', '-');
  }

  static naturalSort(a, b) {
    // https://github.com/overset/javascript-natural-sort
    var q, r,
      c = /(^([+\-]?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?(?=\D|\s|$))|^0x[\da-fA-F]+$|\d+)/g,
      d = /^\s+|\s+$/g,
      e = /\s+/g,
      f = /(^([\w ]+,?[\w ]+)?[\w ]+,?[\w ]+\d+:\d+(:\d+)?[\w ]?|^\d{1,4}[\/\-]\d{1,4}[\/\-]\d{1,4}|^\w+, \w+ \d+, \d{4})/,
      g = /^0x[0-9a-f]+$/i,
      h = /^0/,
      i = function(a) {
        return (Ideogram.naturalSort.insensitive && (String(a)).toLowerCase() || String(a)).replace(d, "");
      },
      j = i(a),
      k = i(b),
      l = j.replace(c, "\0$1\0").replace(/\0$/, "").replace(/^\0/, "").split("\0"),
      m = k.replace(c, "\0$1\0").replace(/\0$/, "").replace(/^\0/, "").split("\0"),
      n = parseInt(j.match(g), 16) || l.length !== 1 && Date.parse(j),
      o = parseInt(k.match(g), 16) || n && k.match(f) && Date.parse(k) || null,
      p = function(a, b) {
        return (!a.match(h) || b == 1) && parseFloat(a) || a.replace(e, " ").replace(d, "") || 0;
      }; if (o) {
      if (n < o) {
        return -1;
      } if (n > o) {
        return 1;
      }
    } for (var s = 0, t = l.length, u = m.length, v = Math.max(t, u); s < v; s++) {
      if (q = p(l[s] || "", t), r = p(m[s] || "", u), isNaN(q) !== isNaN(r)) {
        return isNaN(q) ? 1 : -1;
      } if (/[^\x00-\x80]/.test(q + r) && q.localeCompare) {
        var w = q.localeCompare(r); return w / Math.abs(w);
      } if (q < r) {
        return -1;
      } if (q > r) {
        return 1;
      }
    }
  }

  /**
   * Is the assembly in this.config an NCBI Assembly accession?
   *
   * @returns {boolean}
   */
  assemblyIsAccession() {
    return (
      'assembly' in this.config &&
      /(GCF_|GCA_)/.test(this.config.assembly)
    );
  }

  /**
  * Returns directory used to fetch data for bands and annotations
  *
  * This simplifies ideogram configuration.  By default, the dataDir is
  * set to an external CDN unless we're serving from the local host, in
  * which case dataDir is deduced from the "src" attribute of the ideogram
  * script loaded in the document.
   *
   * @returns {String}
   */
  getDataDir() {
    var scripts = document.scripts,
      host = location.host,
      version = Ideogram.version,
      script, tmp, protocol, dataDir;

    if (host !== 'localhost' && host !== '127.0.0.1') {
      return (
        'https://unpkg.com/ideogram@' + version + '/dist/data/bands/native/'
      );
    }

    for (var i = 0; i < scripts.length; i++) {
      script = scripts[i];
      if (
        'src' in script &&
        /ideogram/.test(script.src.split('/').slice(-1))
      ) {
        tmp = script.src.split('//');
        protocol = tmp[0];
        tmp = '/' + tmp[1].split('/').slice(0,-2).join('/');
        dataDir = protocol + '//' + tmp + '/data/bands/native/';
        return dataDir;
      }
    }
    return '../data/bands/native/';
  }

  /**
  * Gets chromosome band data from a
  * TSV file, or, if band data is prefetched, from an array
  *
  * UCSC:
  * #chrom chromStart chromEnd name gieStain
  * http://genome.ucsc.edu/cgi-bin/hgTables
  *  - group: Mapping and Sequencing
  *  - track: Chromosome Band (Ideogram)
  *
  * NCBI:
  * #chromosome arm band iscn_start iscn_stop bp_start bp_stop stain density
  * ftp://ftp.ncbi.nlm.nih.gov/pub/gdp/ideogram_9606_GCF_000001305.14_550_V1
  */
  getBands(content, taxid, chromosomes) {
    var lines = {},
      delimiter, tsvLines, columns, line, stain, chr,
      i, init, tsvLinesLength, source,
      start, stop, firstColumn, tmp;

    if (content.slice(0, 15) === 'window.chrBands') {
      source = 'native';
    }

    if (
      chromosomes instanceof Array &&
      typeof chromosomes[0] === 'object'
    ) {
      tmp = [];
      for (i = 0; i < chromosomes.length; i++) {
        tmp.push(chromosomes[i].name);
      }
      chromosomes = tmp;
    }

    if (typeof chrBands === 'undefined' && source !== 'native') {
      delimiter = /\t/;
      tsvLines = content.split(/\r\n|\n/);
      init = 1;
    } else {
      delimiter = / /;
      if (source === 'native') {
        tsvLines = eval(content);
      } else {
        tsvLines = content;
      }
      init = 0;
    }

    firstColumn = tsvLines[0].split(delimiter)[0];
    if (firstColumn === '#chromosome') {
      source = 'ncbi';
    } else if (firstColumn === '#chrom') {
      source = 'ucsc';
    } else {
      source = 'native';
    }

    tsvLinesLength = tsvLines.length;

    if (source === 'ncbi' || source === 'native') {
      for (i = init; i < tsvLinesLength; i++) {
        columns = tsvLines[i].split(delimiter);

        chr = columns[0];

        if (
          // If a specific set of chromosomes has been requested, and
          // the current chromosome
          typeof (chromosomes) !== 'undefined' &&
          chromosomes.indexOf(chr) === -1
        ) {
          continue;
        }

        if (chr in lines === false) {
          lines[chr] = [];
        }

        stain = columns[7];
        if (columns[8]) {
          // For e.g. acen and gvar, columns[8] (density) is undefined
          stain += columns[8];
        }

        line = {
          chr: chr,
          bp: {
            start: parseInt(columns[5], 10),
            stop: parseInt(columns[6], 10)
          },
          iscn: {
            start: parseInt(columns[3], 10),
            stop: parseInt(columns[4], 10)
          },
          px: {
            start: -1,
            stop: -1,
            width: -1
          },
          name: columns[1] + columns[2],
          stain: stain,
          taxid: taxid
        };

        lines[chr].push(line);
      }
    } else if (source === 'ucsc') {
      for (i = init; i < tsvLinesLength; i++) {
        // #chrom chromStart  chromEnd  name  gieStain
        // e.g. for fly:
        // chr4	69508	108296	102A1	n/a
        columns = tsvLines[i].split(delimiter);

        if (columns[0] !== 'chr' + chromosomeName) {
          continue;
        }

        stain = columns[4];
        if (stain === 'n/a') {
          stain = 'gpos100';
        }
        start = parseInt(columns[1], 10);
        stop = parseInt(columns[2], 10);

        line = {
          chr: columns[0].split('chr')[1],
          bp: {
            start: start,
            stop: stop
          },
          iscn: {
            start: start,
            stop: stop
          },
          px: {
            start: -1,
            stop: -1,
            width: -1
          },
          name: columns[3],
          stain: stain,
          taxid: taxid
        };

        lines[chr].push(line);
      }
    }

    return lines;
  }

  /**
  * Generates a model object for each chromosome containing information on
  * its name, DOM ID, length in base pairs or ISCN coordinates, cytogenetic
  * bands, centromere position, etc.
  */
  getChromosomeModel(bands, chromosome, taxid, chrIndex) {
    var chr = {},
      band,
      width, pxStop,
      chrHeight = this.config.chrHeight,
      maxLength = this.maxLength,
      chrLength,
      cs, hasBands;

    cs = this.coordinateSystem;
    hasBands = (typeof bands !== 'undefined');

    if (hasBands) {
      chr.name = chromosome;
      chr.length = bands[bands.length - 1][cs].stop;
      chr.type = 'nuclear';
    } else {
      chr = chromosome;
    }

    chr.chrIndex = chrIndex;

    chr.id = 'chr' + chr.name + '-' + taxid;

    if (this.config.fullChromosomeLabels === true) {
      var orgName = this.organisms[taxid].scientificNameAbbr;
      chr.name = orgName + ' chr' + chr.name;
    }

    chrLength = chr.length;

    pxStop = 0;

    if (hasBands) {
      for (var i = 0; i < bands.length; i++) {
        band = bands[i];
        var csLength = band[cs].stop - band[cs].start;
        width = chrHeight * chr.length / maxLength[cs] * csLength / chrLength;

        bands[i].px = {start: pxStop, stop: pxStop + width, width: width};

        pxStop = bands[i].px.stop;

        if (hasBands && band.stain === 'acen' && band.name[0] === 'p') {
          chr.pcenIndex = i;
        }
      }
    } else {
      pxStop = chrHeight * chr.length / maxLength[cs];
    }

    chr.width = pxStop;

    chr.scale = {};

    // TODO:
    //
    // A chromosome-level scale property is likely
    // nonsensical for any chromosomes that have cytogenetic band data.
    // Different bands tend to have ratios between number of base pairs
    // and physical length.
    //
    // However, a chromosome-level scale property is likely
    // necessary for chromosomes that do not have band data.
    //
    // This needs further review.
    if (this.config.multiorganism === true) {
      chr.scale.bp = 1;
      // chr.scale.bp = band.iscn.stop / band.bp.stop;
      chr.scale.iscn = chrHeight * chrLength / maxLength.bp;
    } else {
      chr.scale.bp = chrHeight / maxLength.bp;
      if (hasBands) {
        chr.scale.iscn = chrHeight / maxLength.iscn;
      }
    }
    chr.bands = bands;

    chr.centromerePosition = '';
    if (
      hasBands && bands[0].name[0] === 'p' && bands[1].name[0] === 'q' &&
      bands[0].bp.stop - bands[0].bp.start < 2E6
    ) {
      // As with almost all mouse chromosome, chimpanzee chr22
      chr.centromerePosition = 'telocentric';

      // Remove placeholder pter band
      chr.bands = chr.bands.slice(1);
    }

    if (hasBands && chr.bands.length === 1) {
      // Encountered when processing an assembly that has chromosomes with
      // centromere data, but this chromosome does not.
      // Example: chromosome F1 in Felis catus.
      delete chr.bands;
    }

    return chr;
  }

  /**
  * Draws labels for each chromosome, e.g. "1", "2", "X".
  * If ideogram configuration has 'fullChromosomeLabels: True',
  * then labels includes name of taxon, which can help when
  * depicting orthologs.
  */
  drawChromosomeLabels() {
    var ideo = this;

    var chromosomeLabelClass = ideo._layout.getChromosomeLabelClass();

    var chrSetLabelXPosition = ideo._layout.getChromosomeSetLabelXPosition();
    var chrSetLabelTranslate = ideo._layout.getChromosomeSetLabelTranslate();

    // Append chromosomes set's labels
    d3.selectAll(ideo.selector + ' .chromosome-set-container')
      .append('text')
      .data(ideo.chromosomesArray)
      .attr('class', 'chromosome-set-label ' + chromosomeLabelClass)
      .attr('transform', chrSetLabelTranslate)
      .attr('x', chrSetLabelXPosition)
      .attr('y', function(d, i) {
        return ideo._layout.getChromosomeSetLabelYPosition(i);
      })
      .attr('text-anchor', ideo._layout.getChromosomeSetLabelAnchor())
      .each(function(d, i) {
        // Get label lines
        var lines;
        if (d.name.indexOf(' ') === -1) {
          lines = [d.name];
        } else {
          lines = d.name.match(/^(.*)\s+([^\s]+)$/).slice(1).reverse();
        }

        if (
          'sex' in ideo.config &&
          ideo.config.ploidy === 2 &&
          i === ideo.sexChromosomes.index
        ) {
          if (ideo.config.sex === 'male') {
            lines = ['XY'];
          } else {
            lines = ['XX'];
          }
        }

        // Render label lines
        d3.select(this).selectAll('tspan')
          .data(lines)
          .enter()
          .append('tspan')
          .attr('dy', function(d, i) {
            return i * -1.2 + 'em';
          })
          .attr('x', ideo._layout.getChromosomeSetLabelXPosition())
          .attr('class', function(a, i) {
            var fullLabels = ideo.config.fullChromosomeLabels;
            return i === 1 && fullLabels ? 'italic' : null;
          }).text(String);
      });

    var setLabelTranslate = ideo._layout.getChromosomeSetLabelTranslate();

    // Append chromosomes labels
    d3.selectAll(ideo.selector + ' .chromosome-set-container')
      .each(function(a, chrSetNumber) {
        d3.select(this).selectAll('.chromosome')
          .append('text')
          .attr('class', 'chrLabel')
          .attr('transform', setLabelTranslate)
          .attr('x', function(d, i) {
            return ideo._layout.getChromosomeLabelXPosition(i);
          }).attr('y', function(d, i) {
            return ideo._layout.getChromosomeLabelYPosition(i);
          }).text(function(d, chrNumber) {
            return ideo._ploidy.getAncestor(chrSetNumber, chrNumber);
          }).attr('text-anchor', 'middle');
      });
  }

  /**
  * Draws labels and stalks for cytogenetic bands.
  *
  * Band labels are text like "p11.11".
  * Stalks are small lines that visually connect labels to their bands.
  */
  drawBandLabels(chromosomes) {
    var i, chr, chrs, taxid, ideo, chrModel, chrIndex, textOffsets;

    ideo = this;

    chrs = [];

    for (taxid in chromosomes) {
      for (chr in chromosomes[taxid]) {
        chrs.push(chromosomes[taxid][chr]);
      }
    }

    textOffsets = {};

    chrIndex = 0;
    for (i = 0; i < chrs.length; i++) {
      chrIndex += 1;

      chrModel = chrs[i];

      chr = d3.select(ideo.selector + ' #' + chrModel.id);

      // var chrMargin = this.config.chrMargin * chrIndex,
      //   lineY1, lineY2;
      //
      // lineY1 = chrMargin;
      // lineY2 = chrMargin - 8;
      //
      // if (
      //   chrIndex === 1 &&
      //   "perspective" in this.config && this.config.perspective === "comparative"
      // ) {
      //   lineY1 += 18;
      //   lineY2 += 18;
      // }

      textOffsets[chrModel.id] = [];

      chr.selectAll('text')
        .data(chrModel.bands)
        .enter()
        .append('g')
        .attr('class', function(d, i) {
          return 'bandLabel bsbsl-' + i;
        })
        .attr('transform', function(d) {
          var transform = ideo._layout.getChromosomeBandLabelTranslate(d, i);

          var x = transform.x;
          // var y = transform.y;

          textOffsets[chrModel.id].push(x + 13);

          return transform.translate;
        })
        .append('text')
        .attr('text-anchor', ideo._layout.getChromosomeBandLabelAnchor(i))
        .text(function(d) {
          return d.name;
        });

      // var adapter = ModelAdapter.getInstance(ideo.chromosomesArray[i]);
      // var view = Chromosome.getInstance(adapter, ideo.config, ideo);

      chr.selectAll('line.bandLabelStalk')
        .data(chrModel.bands)
        .enter()
        .append('g')
        .attr('class', function(d, i) {
          return 'bandLabelStalk bsbsl-' + i;
        })
        .attr('transform', function(d) {
          var x, y;

          x = ideo.round(d.px.start + d.px.width / 2);

          textOffsets[chrModel.id].push(x + 13);
          y = -10;

          return 'translate(' + x + ',' + y + ')';
        })
        .append('line')
        .attr('x1', 0)
        .attr('y1', function() {
          return ideo._layout.getChromosomeBandTickY1(i);
        })
        .attr('x2', 0)
        .attr('y2', function() {
          return ideo._layout.getChromosomeBandTickY2(i);
        });
    }

    for (i = 0; i < chrs.length; i++) {
      chrModel = chrs[i];

      var textsLength = textOffsets[chrModel.id].length,
        overlappingLabelXRight,
        index,
        indexesToShow = [],
        prevHiddenBoxIndex,
        xLeft,
        prevLabelXRight,
        prevTextBoxLeft,
        prevTextBoxWidth,
        textPadding;

      overlappingLabelXRight = 0;

      textPadding = 5;

      for (index = 0; index < textsLength; index++) {
        // Ensures band labels don't overlap

        xLeft = textOffsets[chrModel.id][index];

        if (xLeft < overlappingLabelXRight + textPadding === false) {
          indexesToShow.push(index);
        } else {
          prevHiddenBoxIndex = index;
          overlappingLabelXRight = prevLabelXRight;
          continue;
        }

        if (prevHiddenBoxIndex !== index) {
          // This getBoundingClientRect() forces Chrome's
          // 'Recalculate Style' and 'Layout', which takes 30-40 ms on Chrome.
          // TODO: This forced synchronous layout would be nice to eliminate.
          // prevTextBox = texts[index].getBoundingClientRect();
          // prevLabelXRight = prevTextBox.left + prevTextBox.width;

          // TODO: Account for number of characters in prevTextBoxWidth,
          // maybe also zoom.
          prevTextBoxLeft = textOffsets[chrModel.id][index];
          prevTextBoxWidth = 36;

          prevLabelXRight = prevTextBoxLeft + prevTextBoxWidth;
        }

        if (
          xLeft < prevLabelXRight + textPadding
        ) {
          prevHiddenBoxIndex = index;
          overlappingLabelXRight = prevLabelXRight;
        } else {
          indexesToShow.push(index);
        }
      }

      var selectorsToShow = [],
        ithLength = indexesToShow.length,
        j;

      for (j = 0; j < ithLength; j++) {
        index = indexesToShow[j];
        selectorsToShow.push('#' + chrModel.id + ' .bsbsl-' + index);
      }

      this.bandsToShow = this.bandsToShow.concat(selectorsToShow);
    }
  }

  /**
   * Rotates chromosome labels by 90 degrees, e.g. upon clicking a chromosome to focus.
   */
  rotateChromosomeLabels(chr, chrIndex, orientation, scale) {
    var chrMargin, chrWidth, ideo, x, y,
      numAnnotTracks, scaleSvg, tracksHeight, chrMargin2;

    chrWidth = this.config.chrWidth;
    chrMargin = this.config.chrMargin * chrIndex;
    numAnnotTracks = this.config.numAnnotTracks;

    ideo = this;

    if (
      typeof (scale) !== 'undefined' &&
      scale.hasOwnProperty('x') &&
      !(scale.x === 1 && scale.y === 1)
    ) {
      scaleSvg = 'scale(' + scale.x + ',' + scale.y + ')';
      x = -6;
      y = (scale === '' ? -16 : -14);
    } else {
      x = -8;
      y = -16;
      scale = {x: 1, y: 1};
      scaleSvg = '';
    }

    if (orientation === 'vertical' || orientation === '') {
      var ci = chrIndex - 1;

      if (numAnnotTracks > 1 || orientation === '') {
        ci -= 1;
      }

      chrMargin2 = -4;
      if (ideo.config.showBandLabels === true) {
        chrMargin2 = ideo.config.chrMargin + chrWidth + 26;
      }

      chrMargin = ideo.config.chrMargin * ci;

      if (numAnnotTracks > 1 === false) {
        chrMargin += 1;
      }

      y = chrMargin + chrMargin2;

      chr.selectAll('text.chrLabel')
        .attr('transform', scaleSvg)
        .selectAll('tspan')
        .attr('x', x)
        .attr('y', y);
    } else {
      chrIndex -= 1;

      chrMargin2 = -chrWidth - 2;
      if (ideo.config.showBandLabels === true) {
        chrMargin2 = ideo.config.chrMargin + 8;
      }

      tracksHeight = ideo.config.annotTracksHeight;
      if (ideo.config.annotationsLayout !== 'overlay') {
        tracksHeight *= 2;
      }

      chrMargin = ideo.config.chrMargin * chrIndex;
      x = -(chrMargin + chrMargin2) + 3 + tracksHeight;
      x /= scale.x;

      chr.selectAll('text.chrLabel')
        .attr('transform', 'rotate(-90)' + scaleSvg)
        .selectAll('tspan')
        .attr('x', x)
        .attr('y', y);
    }
  }

  round(coord) {
    // Rounds an SVG coordinates to two decimal places
    // e.g. 42.1234567890 -> 42.12
    // Per http://stackoverflow.com/a/9453447, below method is fastest
    return Math.round(coord * 100) / 100;
  }

  /**
  * Renders all the bands and outlining boundaries of a chromosome.
  */
  drawChromosome(chrModel, chrIndex, container, k) {
    var chrMargin = this.config.chrMargin;

    // Get chromosome model adapter class
    var adapter = ModelAdapter.getInstance(chrModel);

    // Append chromosome's container
    var chromosome = container
      .append('g')
      .attr('id', chrModel.id)
      .attr('class', 'chromosome ' + adapter.getCssClass())
      .attr('transform', 'translate(0, ' + k * chrMargin + ')');

    // Render chromosome
    return Chromosome.getInstance(adapter, this.config, this)
      .render(chromosome, chrIndex, k);
  }

  /**
  * Rotates a chromosome 90 degrees and shows or hides all other chromosomes
  * Useful for focusing or defocusing a particular chromosome
  */
  rotateAndToggleDisplay(chromosome) {
    // Do nothing if taxId not defined. But it should be defined.
    // To fix that bug we should have a way to find chromosome set number.
    if (!this.config.taxid) {
      return;
    }

    var chrSetNumber =
      Number(d3.select(chromosome.parentNode).attr('data-set-number'));

    var chrNumber = Array.prototype.slice.call(
      d3.select(chromosome.parentNode).selectAll('g.chromosome')._groups[0]
    ).indexOf(chromosome);

    return this._layout.rotate(chrSetNumber, chrNumber, chromosome);
  }

  /**
  * Converts base pair coordinates to pixel offsets.
  * Bp-to-pixel scales differ among cytogenetic bands.
  */
  convertBpToPx(chr, bp) {
    var i, band, bpToIscnScale, iscn, px, offset, pxStart, pxLength, iscnStart,
      iscnStop, iscnLength, bpStart, bpStop, bpLength;

    for (i = 0; i < chr.bands.length; i++) {
      band = chr.bands[i];

      offset = this._bandsXOffset;
      bpStart = band.bp.start;
      bpStop = band.bp.stop;
      bpLength = bpStop - bpStart;
      iscnStart = band.iscn.start;
      iscnStop = band.iscn.stop;
      iscnLength = iscnStop - iscnStart;
      pxStart = band.px.start;
      pxLength = band.px.width;

      if (bp >= bpStart && bp <= bpStop) {
        bpToIscnScale = iscnLength / bpLength;
        iscn = iscnStart + (bp - bpStart) * bpToIscnScale;

        px = offset + pxStart + (pxLength * (iscn - iscnStart) / (iscnLength));

        return px;
      }
    }

    throw new Error(
      'Base pair out of range.  ' +
      'bp: ' + bp + '; length of chr' + chr.name + ': ' + band.bp.stop
    );
  }

  /**
  * Converts base pair coordinates to pixel offsets.
  * Bp-to-pixel scales differ among cytogenetic bands.
  */
  convertPxToBp(chr, px) {
    var i, band, pxToIscnScale, iscn, bp, pxLength,
      pxStart, pxStop, iscnStart, iscnStop, bpLength, iscnLength;

    if (px === 0) {
      px = chr.bands[0].px.start;
    }

    for (i = 0; i < chr.bands.length; i++) {
      band = chr.bands[i];

      pxStart = band.px.start;
      pxStop = band.px.stop;
      iscnStart = band.iscn.start;
      iscnStop = band.iscn.stop;

      if (px >= pxStart && px <= pxStop) {
        iscnLength = iscnStop - iscnStart;
        pxLength = pxStop - pxStart;
        bpLength = band.bp.stop - band.bp.start;

        pxToIscnScale = iscnLength / pxLength;
        iscn = iscnStart + (px - pxStart) * pxToIscnScale;

        bp = band.bp.start + (bpLength * (iscn - iscnStart) / iscnLength);

        return Math.round(bp);
      }
    }

    throw new Error(
      'Pixel out of range.  ' +
      'px: ' + px + '; length of chr' + chr.name + ': ' + pxStop
    );
  }

  /**
  * Draws a trapezoid connecting a genomic range on
  * one chromosome to a genomic range on another chromosome;
  * a syntenic region.
  */
  drawSynteny(syntenicRegions) {
    var t0 = new Date().getTime();

    var r1, r2,
      syntenies,
      i, color, opacity,
      regionID, regions, syntenicRegion,
      ideo = this;

    syntenies = d3.select(ideo.selector)
      .insert('g', ':first-child')
      .attr('class', 'synteny');

    for (i = 0; i < syntenicRegions.length; i++) {
      regions = syntenicRegions[i];

      r1 = regions.r1;
      r2 = regions.r2;

      color = '#CFC';
      if ('color' in regions) {
        color = regions.color;
      }

      opacity = 1;
      if ('opacity' in regions) {
        opacity = regions.opacity;
      }

      r1.startPx = this.convertBpToPx(r1.chr, r1.start);
      r1.stopPx = this.convertBpToPx(r1.chr, r1.stop);
      r2.startPx = this.convertBpToPx(r2.chr, r2.start);
      r2.stopPx = this.convertBpToPx(r2.chr, r2.stop);

      regionID = (
        r1.chr.id + '_' + r1.start + '_' + r1.stop + '_' +
      '__' +
      r2.chr.id + '_' + r2.start + '_' + r2.stop
      );

      syntenicRegion = syntenies.append('g')
        .attr('class', 'syntenicRegion')
        .attr('id', regionID)
        .on('click', function() {
          var activeRegion = this;
          var others = d3.selectAll(ideo.selector + ' .syntenicRegion')
            .filter(function() {
              return (this !== activeRegion);
            });

          others.classed('hidden', !others.classed('hidden'));
        })
        .on('mouseover', function() {
          var activeRegion = this;
          d3.selectAll(ideo.selector + ' .syntenicRegion')
            .filter(function() {
              return (this !== activeRegion);
            })
            .classed('ghost', true);
        })
        .on('mouseout', function() {
          d3.selectAll(ideo.selector + ' .syntenicRegion')
            .classed('ghost', false);
        });
      var chrWidth = ideo.config.chrWidth;
      var x1 = this._layout.getChromosomeSetYTranslate(0);
      var x2 = this._layout.getChromosomeSetYTranslate(1) - chrWidth;

      syntenicRegion.append('polygon')
        .attr('points',
          x1 + ', ' + r1.startPx + ' ' +
          x1 + ', ' + r1.stopPx + ' ' +
          x2 + ', ' + r2.stopPx + ' ' +
          x2 + ', ' + r2.startPx
        )
        .attr('style', 'fill: ' + color + '; fill-opacity: ' + opacity);

      syntenicRegion.append('line')
        .attr('class', 'syntenyBorder')
        .attr('x1', x1)
        .attr('x2', x2)
        .attr('y1', r1.startPx)
        .attr('y2', r2.startPx);

      syntenicRegion.append('line')
        .attr('class', 'syntenyBorder')
        .attr('x1', x1)
        .attr('x2', x2)
        .attr('y1', r1.stopPx)
        .attr('y2', r2.stopPx);
    }

    var t1 = new Date().getTime();
    if (ideo.config.debug) {
      console.log('Time in drawSyntenicRegions: ' + (t1 - t0) + ' ms');
    }
  }

  /**
   * Custom event handler, fired upon dragging sliding window on chromosome
   */
  onBrushMove() {
    call(this.onBrushMoveCallback);
  }

  /**
   * Creates a sliding window along a chromosome
   *
   * @param from Genomic start coordinate, in base pairs
   * @param to Genomic end coordinate, in base pairs
   */
  createBrush(from, to) {
    var ideo = this,
      width = ideo.config.chrWidth + 6.5,
      length = ideo.config.chrHeight,
      chr = ideo.chromosomesArray[0],
      chrLengthBp = chr.bands[chr.bands.length - 1].bp.stop,
      x0, x1,
      xOffset = this._layout.getMargin().left,
      xScale = d3.scaleLinear()
        .domain([0, d3.max(chr.bands, function(band) {
          return band.bp.stop;
        })]).range([xOffset, d3.max(chr.bands, function(band) {
          return band.px.stop;
        }) + xOffset]);

    if (typeof from === 'undefined') {
      from = Math.floor(chrLengthBp / 10);
    }

    if (typeof right === 'undefined') {
      to = Math.ceil(from * 2);
    }

    x0 = ideo.convertBpToPx(chr, from);
    x1 = ideo.convertBpToPx(chr, to);

    ideo.selectedRegion = {from: from, to: to, extent: (to - from)};

    ideo.brush = d3.brushX()
      .extent([[xOffset, 0], [length + xOffset, width]])
      .on('brush', onBrushMove);

    var yTranslate = this._layout.getChromosomeSetYTranslate(0);
    var yOffset = yTranslate + (ideo.config.chrWidth - width) / 2;
    d3.select(ideo.selector).append('g')
      .attr('class', 'brush')
      .attr('transform', 'translate(0, ' + yOffset + ')')
      .call(ideo.brush)
      .call(ideo.brush.move, [x0, x1]);

    function onBrushMove() {
      var extent = currentEvent.selection.map(xScale.invert),
        from = Math.floor(extent[0]),
        to = Math.ceil(extent[1]);

      ideo.selectedRegion = {from: from, to: to, extent: (to - from)};

      if (ideo.onBrushMove) {
        ideo.onBrushMoveCallback();
      }
    }
  }

  /**
  * Called when Ideogram has finished initializing.
  * Accounts for certain ideogram properties not being set until
  * asynchronous requests succeed, etc.
  */
  onLoad() {
    call(this.onLoadCallback);
  }

  /**
  * Returns SVG gradients that give chromosomes a polished look
  */
  getBandColorGradients() {
    var colors,
      stain, color1, color2, color3,
      css,
      gradients = '';

    colors = [
      ['gneg', '#FFF', '#FFF', '#DDD'],
      ['gpos25', '#C8C8C8', '#DDD', '#BBB'],
      ['gpos33', '#BBB', '#BBB', '#AAA'],
      ['gpos50', '#999', '#AAA', '#888'],
      ['gpos66', '#888', '#888', '#666'],
      ['gpos75', '#777', '#777', '#444'],
      ['gpos100', '#444', '#666', '#000'],
      ['acen', '#FEE', '#FEE', '#FDD'],
      ['noBands', '#BBB', '#BBB', '#AAA']
    ];

    for (var i = 0; i < colors.length; i++) {
      stain = colors[i][0];
      color1 = colors[i][1];
      color2 = colors[i][2];
      color3 = colors[i][3];
      gradients +=
      '<linearGradient id="' + stain + '" x1="0%" y1="0%" x2="0%" y2="100%">';
      if (stain === "gneg") {
        gradients +=
        '<stop offset="70%" stop-color="' + color2 + '" />' +
        '<stop offset="95%" stop-color="' + color3 + '" />' +
        '<stop offset="100%" stop-color="' + color1 + '" />';
      } else {
        gradients +=
        '<stop offset="5%" stop-color="' + color1 + '" />' +
        '<stop offset="15%" stop-color="' + color2 + '" />' +
        '<stop offset="60%" stop-color="' + color3 + '" />';
      }
      gradients +=
      '</linearGradient>';
    }

    css = '<style>' +
      'svg#_ideogram  {padding-left: 5px;} ' +
      'svg#_ideogram .labeled {padding-left: 15px;} ' +
      'svg#_ideogram.labeledLeft {padding-left: 15px; padding-top: 15px;} ' +
      // Tahoma has great readability and space utilization at small sizes
      // More: http://ux.stackexchange.com/a/3334
      '#_ideogram text {font: 9px Tahoma; fill: #000;} ' +
      '#_ideogram .italic {font-style: italic;} ' +
      // Fill below is fallback for IE11
      '#_ideogram .chromosome {cursor: pointer; fill: #AAA;}' +
      '#_ideogram .chrSetLabel {font-weight: bolder;}' +
      '#_ideogram .ghost {opacity: 0.2;}' +
      '#_ideogram .hidden {display: none;}' +
      '#_ideogram .bandLabelStalk line {stroke: #AAA; stroke-width: 1;}' +
      '#_ideogram .syntenyBorder {stroke:#AAA;stroke-width:1;}' +
      '#_ideogram .brush .selection {' +
      '  fill: #F00;' +
      '  stroke: #F00;' +
      '  fill-opacity: .3;' +
      '  shape-rendering: crispEdges;' +
      '}' +
      '#_ideogram .noBands {fill: #AAA;}' +
      // NCBI stain density colors
      '#_ideogram .gneg {fill: #FFF}' +
      '#_ideogram .gpos25 {fill: #BBB}' +
      '#_ideogram .gpos33 {fill: #AAA}' +
      '#_ideogram .gpos50 {fill: #888}' +
      '#_ideogram .gpos66 {fill: #666}' +
      '#_ideogram .gpos75 {fill: #444}' +
      '#_ideogram .gpos100 {fill: #000}' +
      '#_ideogram .gpos {fill: #000}' +
      '#_ideogram .acen {fill: #FDD}' +
      '#_ideogram .stalk {fill: #CCE;}' +
      '#_ideogram .gvar {fill: #DDF}' +
      // Used when overlaid with annotations
      '#_ideogram.faint .gneg {fill: #FFF}' +
      '#_ideogram.faint .gpos25 {fill: #EEE}' +
      '#_ideogram.faint .gpos33 {fill: #EEE}' +
      '#_ideogram.faint .gpos50 {fill: #EEE}' +
      '#_ideogram.faint .gpos66 {fill: #EEE}' +
      '#_ideogram.faint .gpos75 {fill: #EEE}' +
      '#_ideogram.faint .gpos100 {fill: #DDD}' +
      '#_ideogram.faint .gpos {fill: #DDD}' +
      '#_ideogram.faint .acen {fill: #FEE}' +
      '#_ideogram.faint .stalk {fill: #EEF;}' +
      '#_ideogram.faint .gvar {fill: #EEF}' +
      '.gneg {fill: url("#gneg")} ' +
      '.gpos25 {fill: url("#gpos25")} ' +
      '.gpos33 {fill: url("#gpos33")} ' +
      '.gpos50 {fill: url("#gpos50")} ' +
      '.gpos66 {fill: url("#gpos66")} ' +
      '.gpos75 {fill: url("#gpos75")} ' +
      '.gpos100 {fill: url("#gpos100")} ' +
      '.gpos {fill: url("#gpos100")} ' +
      '.acen {fill: url("#acen")} ' +
      '.stalk {fill: url("#stalk")} ' +
      '.gvar {fill: url("#gvar")} ' +
      '.noBands {fill: url("#noBands")} ' +
      '.chromosome {fill: url("#noBands")} ' +
      '</style>';

    gradients +=
    '<pattern id="stalk" width="2" height="1" patternUnits="userSpaceOnUse" ' +
      'patternTransform="rotate(30 0 0)">' +
      '<rect x="0" y="0" width="10" height="2" fill="#CCE" /> ' +
       '<line x1="0" y1="0" x2="0" y2="100%" style="stroke:#88B; ' +
        'stroke-width:0.7;" />' +
    '</pattern>' +
    '<pattern id="gvar" width="2" height="1" patternUnits="userSpaceOnUse" ' +
      'patternTransform="rotate(-30 0 0)">' +
      '<rect x="0" y="0" width="10" height="2" fill="#DDF" /> ' +
       '<line x1="0" y1="0" x2="0" y2="100%" style="stroke:#99C; ' +
          'stroke-width:0.7;" />' +
    '</pattern>';
    gradients = "<defs>" + gradients + "</defs>";
    gradients = css + gradients;

    return gradients;
  }

  /**
   * Sorts two chromosome objects by type and name
   * - Nuclear chromosomes come before non-nuclear chromosomes.
   * - Among nuclear chromosomes, use "natural sorting", e.g.
   *   numbers come before letters
   * - Among non-nuclear chromosomes, i.e. "MT" (mitochondrial DNA) and
   *   "CP" (chromoplast DNA), MT comes first
   *
   *
   * @param a Chromosome object "A"
   * @param b Chromosome object "B"
   * @returns {Number} JavaScript sort order indicator
   */
  sortChromosomes(a, b) {
    var aIsNuclear = a.type === 'nuclear',
      bIsNuclear = b.type === 'nuclear',
      aIsCP = a.type === 'chloroplast',
      bIsCP = b.type === 'chloroplast',
      aIsMT = a.type === 'mitochondrion',
      bIsMT = b.type === 'mitochondrion';
      // aIsPlastid = aIsMT && a.name !== 'MT', // e.g. B1 in rice genome GCF_001433935.1
      // bIsPlastid = bIsMT && b.name !== 'MT';

    if (aIsNuclear && bIsNuclear) {
      return Ideogram.naturalSort(a.name, b.name);
    } else if (!aIsNuclear && bIsNuclear) {
      return 1;
    } else if (aIsMT && bIsCP) {
      return 1;
    } else if (aIsCP && bIsMT) {
      return -1;
    } else if (!aIsMT && !aIsCP && (bIsMT || bIsCP)) {
      return -1;
    }
  }

  drawSexChromosomes(bandsArray, taxid, container, defs, j, chrs) {
    var chromosome, bands, chrModel, shape, sci, k,
      sexChromosomeIndexes,
      ideo = this;

    if (ideo.config.sex === 'male') {
      sexChromosomeIndexes = [1, 0];
    } else {
      sexChromosomeIndexes = [0, 0];
    }

    for (k = 0; k < sexChromosomeIndexes.length; k++) {
      sci = sexChromosomeIndexes[k] + j;
      chromosome = chrs[sci];
      bands = bandsArray[sci];
      chrModel = ideo.getChromosomeModel(bands, chromosome, taxid, sci);
      shape = ideo.drawChromosome(chrModel, j, container, k);
      defs.append('clipPath')
        .attr('id', chrModel.id + '-chromosome-set-clippath')
        .selectAll('path')
        .data(shape)
        .enter()
        .append('path')
        .attr('d', function(d) {
          return d.path;
        }).attr('class', function(d) {
          return d.class;
        });
    }
  }

  /**
  * Configures chromosome data and calls downstream chromosome drawing functions
  */
  initDrawChromosomes(bandsArray) {
    var ideo = this,
      taxids = ideo.config.taxids,
      ploidy = ideo.config.ploidy,
      taxid,
      chrIndex = 0,
      chrSetNumber = 0,
      bands,
      i, j, chrs, chromosome, chrModel,
      defs, transform;

    defs = d3.select(ideo.selector + ' defs');

    for (i = 0; i < taxids.length; i++) {
      taxid = taxids[i];
      chrs = ideo.config.chromosomes[taxid];

      if (
        typeof chrBands !== 'undefined' &&
        chrs.length >= chrBands.length / 2
      ) {
        ideo.coordinateSystem = 'bp';
      }

      ideo.chromosomes[taxid] = {};

      ideo.setSexChromosomes(chrs);

      for (j = 0; j < chrs.length; j++) {
        chromosome = chrs[j];
        bands = bandsArray[chrIndex];
        chrIndex += 1;

        chrModel = ideo.getChromosomeModel(bands, chromosome, taxid, chrIndex);

        if (typeof chromosome !== 'string') {
          chromosome = chromosome.name;
        }

        ideo.chromosomes[taxid][chromosome] = chrModel;
        ideo.chromosomesArray.push(chrModel);

        if (
          'sex' in ideo.config &&
          (
            ploidy === 2 && ideo.sexChromosomes.index + 2 === chrIndex ||
            ideo.config.sex === 'female' && chrModel.name === 'Y'
          )
        ) {
          continue;
        }

        transform = ideo._layout.getChromosomeSetTranslate(chrSetNumber);
        chrSetNumber += 1;

        // Append chromosome set container
        var container = d3.select(ideo.selector)
          .append('g')
          .attr('class', 'chromosome-set-container')
          .attr('data-set-number', j)
          .attr('transform', transform)
          .attr('id', chrModel.id + '-chromosome-set');

        if (
          'sex' in ideo.config &&
          ploidy === 2 &&
          ideo.sexChromosomes.index + 1 === chrIndex
        ) {
          ideo.drawSexChromosomes(bandsArray, taxid, container, defs, j, chrs);
          continue;
        }

        var shape;
        var numChrsInSet = 1;
        if (ploidy > 1) {
          numChrsInSet = this._ploidy.getChromosomesNumber(j);
        }
        for (var k = 0; k < numChrsInSet; k++) {
          shape = ideo.drawChromosome(chrModel, chrIndex - 1, container, k);
        }

        defs.append('clipPath')
          .attr('id', chrModel.id + '-chromosome-set-clippath')
          .selectAll('path')
          .data(shape)
          .enter()
          .append('path')
          .attr('d', function(d) {
            return d.path;
          }).attr('class', function(d) {
            return d.class;
          });
      }

      if (ideo.config.showBandLabels === true) {
        ideo.drawBandLabels(ideo.chromosomes);
      }
    }
  }

  /**
   * Get ideogram SVG container
   */
  getSvg() {
    return d3.select(this.selector).node();
  }

  /**
  * Sets instance properties regarding sex chromosomes.
  * Currently only supported for mammals.
  * TODO: Support all sexually reproducing taxa
  *   XY sex-determination (mammals):
  *     - Male: XY <- heterogametic
  *     - Female: XX
  *   ZW sex-determination (birds):
  *     - Male: ZZ
  *     - Female: ZW <- heterogametic
  *   X0 sex-determination (some insects):
  *     - Male: X0, i.e. only X <- heterogametic?
  *     - Female: XX
  * TODO: Support sex chromosome aneuploidies in mammals
  *     - Turner syndrome: X0
  *     - Klinefelter syndome: XXY
  *  More types:
  *  https:*en.wikipedia.org/wiki/Category:Sex_chromosome_aneuploidies
  */
  setSexChromosomes(chrs) {
    if (this.config.ploidy !== 2 || !this.config.sex) {
      return;
    }

    var ideo = this,
      sexChrs = {X: 1, Y: 1},
      chr, i;

    ideo.sexChromosomes.list = [];

    for (i = 0; i < chrs.length; i++) {
      chr = chrs[i];

      if (ideo.config.sex === 'male' && chr in sexChrs) {
        ideo.sexChromosomes.list.push(chr);
        if (!ideo.sexChromosomes.index) {
          ideo.sexChromosomes.index = i;
        }
      } else if (chr === 'X') {
        ideo.sexChromosomes.list.push(chr, chr);
        ideo.sexChromosomes.index = i;
      }
    }
  }

  /**
  * Completes default ideogram initialization by calling downstream functions
  * to process raw band data into full JSON objects, render chromosome and
  * cytoband figures and labels, apply initial graphical transformations,
  * hide overlapping band labels, and execute callbacks defined by client code
  */
  processBandData() {
    var bandsArray, i, j, k, chromosome, bands,
      chrLength, chr,
      bandData, bandsByChr,
      taxid, taxids, chrs, chrsByTaxid,
      ideo = this;

    bandsArray = [];

    if (ideo.config.multiorganism === true) {
      ideo.coordinateSystem = 'bp';
      taxids = ideo.config.taxids;
      for (i = 0; i < taxids.length; i++) {
        taxid = taxids[i];
      }
    } else {
      if (typeof ideo.config.taxid === 'undefined') {
        ideo.config.taxid = ideo.config.taxids[0];
      }
      taxid = ideo.config.taxid;
      taxids = [taxid];
      ideo.config.taxids = taxids;
    }

    if ('chromosomes' in ideo.config) {
      chrs = ideo.config.chromosomes;
    }
    if (ideo.config.multiorganism) {
      chrsByTaxid = chrs;
    }

    ideo.config.chromosomes = {};

    var t0B = new Date().getTime();

    for (j = 0; j < taxids.length; j++) {
      taxid = taxids[j];

      if (ideo.config.multiorganism) {
        chrs = chrsByTaxid[taxid];
      }

      if (ideo.coordinateSystem === 'iscn' || ideo.config.multiorganism) {
        bandData = ideo.bandData[taxid];

        bandsByChr = ideo.getBands(bandData, taxid, chrs);

        chrs = Object.keys(bandsByChr).sort(function(a, b) {
          return Ideogram.naturalSort(a, b);
        });

        ideo.config.chromosomes[taxid] = chrs.slice();
        ideo.numChromosomes += ideo.config.chromosomes[taxid].length;

        for (k = 0; k < chrs.length; k++) {
          chromosome = chrs[k];
          bands = bandsByChr[chromosome];
          bandsArray.push(bands);

          chrLength = {
            iscn: bands[bands.length - 1].iscn.stop,
            bp: bands[bands.length - 1].bp.stop
          };

          if (chrLength.iscn > ideo.maxLength.iscn) {
            ideo.maxLength.iscn = chrLength.iscn;
          }

          if (chrLength.bp > ideo.maxLength.bp) {
            ideo.maxLength.bp = chrLength.bp;
          }
        }
      } else if (ideo.coordinateSystem === 'bp') {
        // If lacking band-level data

        ideo.config.chromosomes[taxid] = chrs.slice();
        ideo.numChromosomes += ideo.config.chromosomes[taxid].length;

        for (k = 0; k < chrs.length; k++) {
          chr = chrs[k];
          if (chr.length > ideo.maxLength.bp) {
            ideo.maxLength.bp = chr.length;
          }
        }
      }
    }

    var t1B = new Date().getTime();
    if (ideo.config.debug) {
      console.log('Time in processBandData: ' + (t1B - t0B) + ' ms');
    }

    return bandsArray;
  }

  /**
  * Initializes an ideogram.
  * Sets some high-level properties based on instance configuration,
  * fetches band and annotation data if needed, and
  * writes an SVG element to the document to contain the ideogram
  */
  init() {
    var taxid, i, svgClass;

    var ideo = this;

    var t0 = new Date().getTime();

    var bandsArray = [],
      numBandDataResponses = 0,
      resolution = this.config.resolution,
      accession;

    var promise = new Promise(function(resolve) {
      if (typeof ideo.config.organism === 'number') {
        // 'organism' is a taxid, e.g. 9606
        ideo.getOrganismFromEutils(function() {
          ideo.getTaxids(resolve);
        });
      } else {
        ideo.getTaxids(resolve);
      }
    });

    promise.then(function(taxids) {
      taxid = taxids[0];
      ideo.config.taxid = taxid;
      ideo.config.taxids = taxids;

      var assemblies,
        bandFileName;

      var bandDataFileNames = {
        9606: '',
        10090: ''
      };

      for (i = 0; i < taxids.length; i++) {
        taxid = String(taxids[i]);

        if (!ideo.config.assembly) {
          ideo.config.assembly = 'default';
        }
        assemblies = ideo.organisms[taxid].assemblies;

        if (ideo.assemblyIsAccession()) {
          accession = ideo.config.assembly;
        } else {
          accession = assemblies[ideo.config.assembly];
        }

        bandFileName = [];
        bandFileName.push(
          Ideogram.slugify(ideo.organisms[taxid].scientificName)
        );
        if (accession !== assemblies.default) {
          bandFileName.push(accession);
        }
        if (
          taxid === '9606' &&
          (accession in assemblies === 'false' &&
          Object.values(assemblies).indexOf(ideo.config.assembly) === -1 ||
          (resolution !== '' && resolution !== 850))
        ) {
          bandFileName.push(resolution);
        }
        bandFileName = bandFileName.join('-') + '.js';

        if (taxid === '9606' || taxid === '10090') {
          bandDataFileNames[taxid] = bandFileName;
        }

        if (
          typeof accession !== 'undefined' &&
          /GCA_/.test(ideo.config.assembly) === false &&
          typeof chrBands === 'undefined' && taxid in bandDataFileNames
        ) {
          d3.request(ideo.config.dataDir + bandDataFileNames[taxid])
            .on('beforesend', function(data) {
              // Ensures correct taxid is processed in response callback; using
              // simply 'taxid' variable gives the last *requested* taxid, which
              // fails when dealing with multiple taxa.
              data.taxid = taxid;
            })
            .get(function(error, data) {
              eval(data.response);

              ideo.bandData[data.taxid] = chrBands;
              numBandDataResponses += 1;

              if (numBandDataResponses === taxids.length) {
                bandsArray = ideo.processBandData();
                writeContainer();
              }
            });
        } else {
          if (typeof chrBands !== 'undefined') {
          // If bands already available,
          // e.g. via <script> tag in initial page load
            ideo.bandData[taxid] = chrBands;
          }
          bandsArray = ideo.processBandData();
          writeContainer();
        }
      }
    });

    function writeContainer() {

      if (ideo.config.annotationsPath) {
        ideo.fetchAnnots(ideo.config.annotationsPath);
      }

      // If ploidy description is a string, then convert it to the canonical
      // array format.  String ploidyDesc is used when depicting e.g. parental
      // origin each member of chromosome pair in a human genome.
      // See ploidy_basic.html for usage example.
      if (
        'ploidyDesc' in ideo.config &&
        typeof ideo.config.ploidyDesc === 'string'
      ) {
        var tmp = [];
        for (var i = 0; i < ideo.numChromosomes; i++) {
          tmp.push(ideo.config.ploidyDesc);
        }
        ideo.config.ploidyDesc = tmp;
      }
      // Organism ploidy description
      ideo._ploidy = new Ploidy(ideo.config);

      // Chromosome's layout
      ideo._layout = Layout.getInstance(ideo.config, ideo);

      svgClass = '';
      if (ideo.config.showChromosomeLabels) {
        if (ideo.config.orientation === 'horizontal') {
          svgClass += 'labeledLeft ';
        } else {
          svgClass += 'labeled ';
        }
      }

      if (
        ideo.config.annotationsLayout &&
      ideo.config.annotationsLayout === 'overlay'
      ) {
        svgClass += 'faint';
      }

      var gradients = ideo.getBandColorGradients();
      var svgWidth = ideo._layout.getWidth(taxid);
      var svgHeight = ideo._layout.getHeight(taxid);

      d3.select(ideo.config.container)
        .append('div')
        .append('svg')
        .attr('id', '_ideogram')
        .attr('class', svgClass)
        .attr('width', svgWidth)
        .attr('height', svgHeight)
        .html(gradients);

      finishInit();
    }

    function finishInit() {
      try {
        var t0A = new Date().getTime();

        var i;

        ideo.initDrawChromosomes(bandsArray);

        // Waits for potentially large annotation dataset
        // to be received by the client, then triggers annotation processing
        if (ideo.config.annotationsPath) {
          function pa() {
            if (typeof ideo.timeout !== 'undefined') {
              window.clearTimeout(ideo.timeout);
            }

            ideo.annots = ideo.processAnnotData(ideo.rawAnnots);
            ideo.drawProcessedAnnots(ideo.annots);

            if (typeof crossfilter !== 'undefined' && ideo.initCrossFilter) {
              ideo.initCrossFilter();
            }
          }

          if (ideo.rawAnnots) {
            pa();
          } else {
            (function checkAnnotData() {
              ideo.timeout = setTimeout(function() {
                if (!ideo.rawAnnots) {
                  checkAnnotData();
                } else {
                  pa();
                }
              },
              50
              );
            })();
          }
        }

        if (ideo.config.showBandLabels === true) {
          var bandsToShow = ideo.bandsToShow.join(',');

          // d3.selectAll resolves to querySelectorAll (QSA).
          // QSA takes a surprisingly long time to complete,
          // and scales with the number of selectors.
          // Most bands are hidden, so we can optimize by
          // Hiding all bands, then QSA'ing and displaying the
          // relatively few bands that are shown.
          var t0C = new Date().getTime();
          d3.selectAll(ideo.selector + ' .bandLabel, .bandLabelStalk')
            .style('display', 'none');
          d3.selectAll(bandsToShow).style('display', '');
          var t1C = new Date().getTime();
          if (ideo.config.debug) {
            console.log('Time in showing bands: ' + (t1C - t0C) + ' ms');
          }

          if (ideo.config.orientation === 'vertical') {
            var chrID;
            for (i = 0; i < ideo.chromosomesArray.length; i++) {
              chrID = '#' + ideo.chromosomesArray[i].id;
              ideo.rotateChromosomeLabels(d3.select(chrID), i);
            }
          }
        }

        if (ideo.config.showChromosomeLabels === true) {
          ideo.drawChromosomeLabels(ideo.chromosomes);
        }

        if (ideo.config.brush === true) {
          ideo.createBrush();
        }

        if (ideo.config.annotations) {
          ideo.drawAnnots(ideo.config.annotations);
        }

        var t1A = new Date().getTime();
        if (ideo.config.debug) {
          console.log('Time in drawChromosome: ' + (t1A - t0A) + ' ms');
        }

        var t1 = new Date().getTime();
        if (ideo.config.debug) {
          console.log('Time constructing ideogram: ' + (t1 - t0) + ' ms');
        }

        if (!('rotatable' in ideo.config && ideo.config.rotatable === false)) {
          d3.selectAll(ideo.selector + ' .chromosome').on('click', function() {
            ideo.rotateAndToggleDisplay(this);
          });
        } else {
          d3.selectAll(ideo.selector + ' .chromosome')
            .style('cursor', 'default');
        }

        if (ideo.onLoadCallback) {
          ideo.onLoadCallback();
        }
      } catch (e) {
        // console.log(e);
        throw e;
      }
    }
  }
}