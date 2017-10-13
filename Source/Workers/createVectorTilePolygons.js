define([
        '../Core/AttributeCompression',
        '../Core/Cartesian3',
        '../Core/Cartographic',
        '../Core/Color',
        '../Core/defined',
        '../Core/Ellipsoid',
        '../Core/EllipsoidTangentPlane',
        '../Core/IndexDatatype',
        '../Core/Math',
        '../Core/Matrix4',
        '../Core/OrientedBoundingBox',
        '../Core/PolygonPipeline',
        '../Core/Rectangle',
        '../Core/WindingOrder',
        './createTaskProcessorWorker'
    ], function(
        AttributeCompression,
        Cartesian3,
        Cartographic,
        Color,
        defined,
        Ellipsoid,
        EllipsoidTangentPlane,
        IndexDatatype,
        CesiumMath,
        Matrix4,
        OrientedBoundingBox,
        PolygonPipeline,
        Rectangle,
        WindingOrder,
        createTaskProcessorWorker) {
    'use strict';

    var scratchCenter = new Cartesian3();
    var scratchEllipsoid = new Ellipsoid();
    var scratchRectangle = new Rectangle();
    var scratchMatrix4 = new Matrix4();
    var scratchScalars = {
        min : undefined,
        max : undefined,
        indexBytesPerElement : undefined,
        isCartographic : undefined
    };

    function unpackBuffer(buffer) {
        var packedBuffer = new Float64Array(buffer);

        var offset = 0;
        scratchScalars.indexBytesPerElement = packedBuffer[offset++];

        scratchScalars.min = packedBuffer[offset++];
        scratchScalars.max = packedBuffer[offset++];

        Cartesian3.unpack(packedBuffer, offset, scratchCenter);
        offset += Cartesian3.packedLength;

        Ellipsoid.unpack(packedBuffer, offset, scratchEllipsoid);
        offset += Ellipsoid.packedLength;

        Rectangle.unpack(packedBuffer, offset, scratchRectangle);
        offset += Rectangle.packedLength;

        scratchScalars.isCartographic = packedBuffer[offset++] === 1.0;

        Matrix4.unpack(packedBuffer, offset, scratchMatrix4);
    }

    function packedBatchedIndicesLength(batchedIndices) {
        var length = batchedIndices.length;
        var count = 0;
        for (var i = 0; i < length; ++i) {
            count += Color.packedLength + 3 + batchedIndices[i].batchIds.length;
        }
        return count;
    }

    function packBuffer(indexDatatype, boundingVolumes, batchedIndices) {
        var numBVs = boundingVolumes.length;
        var length = 1 + 1 + numBVs * OrientedBoundingBox.packedLength + 1 + packedBatchedIndicesLength(batchedIndices);

        var packedBuffer = new Float64Array(length);

        var offset = 0;
        packedBuffer[offset++] = indexDatatype;
        packedBuffer[offset++] = numBVs;

        for (var i = 0; i < numBVs; ++i) {
            OrientedBoundingBox.pack(boundingVolumes[i], packedBuffer, offset);
            offset += OrientedBoundingBox.packedLength;
        }

        var indicesLength = batchedIndices.length;
        packedBuffer[offset++] = indicesLength;

        for (var j = 0; j < indicesLength; ++j) {
            var batchedIndex = batchedIndices[j];

            Color.pack(batchedIndex.color, packedBuffer, offset);
            offset += Color.packedLength;

            packedBuffer[offset++] = batchedIndex.offset;
            packedBuffer[offset++] = batchedIndex.count;

            var batchIds = batchedIndex.batchIds;
            var batchIdsLength = batchIds.length;
            packedBuffer[offset++] = batchIdsLength;

            for (var k = 0; k < batchIdsLength; ++k) {
                packedBuffer[offset++] = batchIds[k];
            }
        }

        return packedBuffer;
    }

    var maxShort = 32767;

    var scratchEncodedPosition = new Cartesian3();
    var scratchNormal = new Cartesian3();
    var scratchScaledNormal = new Cartesian3();
    var scratchMinHeightPosition = new Cartesian3();
    var scratchMaxHeightPosition = new Cartesian3();
    var scratchBVCartographic = new Cartographic();
    var scratchBVRectangle = new Rectangle();

    function createVectorTilePolygons(parameters, transferableObjects) {
        unpackBuffer(parameters.packedBuffer);

        var indices;
        var indexBytesPerElement = scratchScalars.indexBytesPerElement;
        if (indexBytesPerElement === 2) {
            indices = new Uint16Array(parameters.indices);
        } else {
            indices = new Uint32Array(parameters.indices);
        }

        var positions = new Uint16Array(parameters.positions);
        var counts = new Uint32Array(parameters.counts);
        var indexCounts = new Uint32Array(parameters.indexCounts);
        var batchIds = new Uint32Array(parameters.batchIds);
        var batchTableColors = new Uint32Array(parameters.batchTableColors);

        var boundingVolumes = new Array(counts.length);

        var center = scratchCenter;
        var ellipsoid = scratchEllipsoid;
        var rectangle = scratchRectangle;
        var minHeight = scratchScalars.min;
        var maxHeight = scratchScalars.max;
        var modelMatrix = scratchMatrix4;
        var isCartographic = scratchScalars.isCartographic;

        var minimumHeights = parameters.minimumHeights;
        var maximumHeights = parameters.maximumHeights;
        if (defined(minimumHeights) && defined(maximumHeights)) {
            minimumHeights = new Float32Array(minimumHeights);
            maximumHeights = new Float32Array(maximumHeights);
        }

        var i;
        var j;
        var rgba;

        var positionsLength = positions.length / 2;
        var uBuffer = positions.subarray(0, positionsLength);
        var vBuffer = positions.subarray(positionsLength, 2 * positionsLength);
        AttributeCompression.zigZagDeltaDecode(uBuffer, vBuffer);

        var decodedPositions = new Float32Array(positionsLength * 3);
        for (i = 0; i < positionsLength; ++i) {
            var u = uBuffer[i];
            var v = vBuffer[i];

            var x = CesiumMath.lerp(rectangle.west, rectangle.east, u / maxShort);
            var y = CesiumMath.lerp(rectangle.south, rectangle.north, v / maxShort);

            var decodedPosition;
            if (isCartographic) {
                var cart = Cartographic.fromRadians(x, y, 0.0, scratchBVCartographic);
                decodedPosition = ellipsoid.cartographicToCartesian(cart, scratchEncodedPosition);
            } else {
                decodedPosition = Cartesian3.fromElements(x, y, 0.0, scratchEncodedPosition);
            }
            Cartesian3.pack(decodedPosition, decodedPositions, i * 3);
        }

        var countsLength = counts.length;
        var offsets = new Array(countsLength);
        var indexOffsets = new Array(countsLength);
        var currentOffset = 0;
        var currentIndexOffset = 0;
        for (i = 0; i < countsLength; ++i) {
            offsets[i] = currentOffset;
            indexOffsets[i] = currentIndexOffset;

            currentOffset += counts[i];
            currentIndexOffset += indexCounts[i];
        }

        var batchedPositions = new Float32Array(positionsLength * 3 * 2);
        var batchedIds = new Uint16Array(positionsLength * 2);
        var batchedIndexOffsets = new Uint32Array(indexOffsets.length);
        var batchedIndexCounts = new Uint32Array(indexCounts.length);
        var batchedIndices = [];

        var colorToBuffers = {};
        for (i = 0; i < countsLength; ++i) {
            rgba = batchTableColors[i];
            if (!defined(colorToBuffers[rgba])) {
                colorToBuffers[rgba] = {
                    positionLength : counts[i],
                    indexLength : indexCounts[i],
                    offset : 0,
                    indexOffset : 0,
                    batchIds : [i]
                };
            } else {
                colorToBuffers[rgba].positionLength += counts[i];
                colorToBuffers[rgba].indexLength += indexCounts[i];
                colorToBuffers[rgba].batchIds.push(i);
            }
        }

        // get the offsets and counts for the positions and indices of each primitive
        var buffer;
        var byColorPositionOffset = 0;
        var byColorIndexOffset = 0;
        for (rgba in colorToBuffers) {
            if (colorToBuffers.hasOwnProperty(rgba)) {
                buffer = colorToBuffers[rgba];
                buffer.offset = byColorPositionOffset;
                buffer.indexOffset = byColorIndexOffset;

                var positionLength = buffer.positionLength * 2;
                var indexLength = buffer.indexLength * 2 + buffer.positionLength * 6;

                byColorPositionOffset += positionLength;
                byColorIndexOffset += indexLength;

                buffer.indexLength = indexLength;
            }
        }

        var batchedDrawCalls = [];

        for (rgba in colorToBuffers) {
            if (colorToBuffers.hasOwnProperty(rgba)) {
                buffer = colorToBuffers[rgba];

                batchedDrawCalls.push({
                    color : Color.fromRgba(parseInt(rgba)),
                    offset : buffer.indexOffset,
                    count : buffer.indexLength,
                    batchIds : buffer.batchIds
                });
            }
        }

        for (i = 0; i < countsLength; ++i) {
            rgba = batchTableColors[i];

            buffer = colorToBuffers[rgba];
            var positionOffset = buffer.offset;
            var positionIndex = positionOffset * 3;
            var batchIdIndex = positionOffset;

            var polygonOffset = offsets[i];
            var polygonCount = counts[i];
            var batchId = batchIds[i];

            var polygonMinimumHeight = minHeight;
            var polygonMaximumHeight = maxHeight;
            if (defined(minimumHeights) && defined(maximumHeights)) {
                polygonMinimumHeight = minimumHeights[i];
                polygonMaximumHeight = maximumHeights[i];
            }

            var minLat = Number.POSITIVE_INFINITY;
            var maxLat = Number.NEGATIVE_INFINITY;
            var minLon = Number.POSITIVE_INFINITY;
            var maxLon = Number.NEGATIVE_INFINITY;

            // TODO: potentially using an releasing a lot of memory here
            var polygonPositions = [];
            var bvPositions = [];

            var position;

            for (j = 0; j < polygonCount; ++j) {
                position = Cartesian3.unpack(decodedPositions, polygonOffset * 3 + j * 3, scratchEncodedPosition);
                Matrix4.multiplyByPoint(modelMatrix, position, position);

                var carto = ellipsoid.cartesianToCartographic(position, scratchBVCartographic);
                var lat = carto.latitude;
                var lon = carto.longitude;

                minLat = Math.min(lat, minLat);
                maxLat = Math.max(lat, maxLat);
                minLon = Math.min(lon, minLon);
                maxLon = Math.max(lon, maxLon);

                var scaledPosition = ellipsoid.scaleToGeodeticSurface(position, position);
                polygonPositions.push(Cartesian3.clone(scaledPosition));
            }

            var tangentPlane = EllipsoidTangentPlane.fromPoints(polygonPositions, ellipsoid);
            var positions2D = tangentPlane.projectPointsOntoPlane(polygonPositions);

            var windingOrder = PolygonPipeline.computeWindingOrder2D(positions2D);
            if (windingOrder === WindingOrder.CLOCKWISE) {
                polygonPositions.reverse();
            }

            for (j = 0; j < polygonCount; ++j) {
                position = polygonPositions[j];

                var normal = ellipsoid.geodeticSurfaceNormal(position, scratchNormal);
                var scaledNormal = Cartesian3.multiplyByScalar(normal, polygonMinimumHeight, scratchScaledNormal);
                var minHeightPosition = Cartesian3.add(position, scaledNormal, scratchMinHeightPosition);

                scaledNormal = Cartesian3.multiplyByScalar(normal, polygonMaximumHeight, scaledNormal);
                var maxHeightPosition = Cartesian3.add(position, scaledNormal, scratchMaxHeightPosition);

                bvPositions.push(Cartesian3.clone(minHeightPosition), Cartesian3.clone(maxHeightPosition));

                Cartesian3.subtract(maxHeightPosition, center, maxHeightPosition);
                Cartesian3.subtract(minHeightPosition, center, minHeightPosition);

                Cartesian3.pack(maxHeightPosition, batchedPositions, positionIndex);
                Cartesian3.pack(minHeightPosition, batchedPositions, positionIndex + 3);

                batchedIds[batchIdIndex] = batchId;
                batchedIds[batchIdIndex + 1] = batchId;

                positionIndex += 6;
                batchIdIndex += 2;
            }

            if (isCartographic) {
                rectangle = scratchBVRectangle;
                rectangle.west = minLon;
                rectangle.east = maxLon;
                rectangle.south = minLat;
                rectangle.north = maxLat;

                boundingVolumes[i] = OrientedBoundingBox.fromRectangle(rectangle, minHeight, maxHeight, ellipsoid);
            } else {
                boundingVolumes[i] = OrientedBoundingBox.fromPoints(bvPositions);
            }

            var indicesIndex = buffer.indexOffset;

            var indexOffset = indexOffsets[i];
            var indexCount = indexCounts[i];

            batchedIndexOffsets[i] = indicesIndex;

            for (j = 0; j < indexCount; j += 3) {
                var i0 = indices[indexOffset + j] - polygonOffset;
                var i1 = indices[indexOffset + j + 1] - polygonOffset;
                var i2 = indices[indexOffset + j + 2] - polygonOffset;

                // triangle on the top of the extruded polygon
                batchedIndices[indicesIndex++] = i0 * 2 + positionOffset;
                batchedIndices[indicesIndex++] = i1 * 2 + positionOffset;
                batchedIndices[indicesIndex++] = i2 * 2 + positionOffset;

                // triangle on the bottom of the extruded polygon
                batchedIndices[indicesIndex++] = i2 * 2 + 1 + positionOffset;
                batchedIndices[indicesIndex++] = i1 * 2 + 1 + positionOffset;
                batchedIndices[indicesIndex++] = i0 * 2 + 1 + positionOffset;
            }

            // indices for the walls of the extruded polygon
            for (j = 0; j < polygonCount; ++j) {
                var v0 = j;
                var v1 = (j + 1) % polygonCount;

                batchedIndices[indicesIndex++] = v0 * 2 + 1 + positionOffset;
                batchedIndices[indicesIndex++] = v1 * 2 + positionOffset;
                batchedIndices[indicesIndex++] = v0 * 2 + positionOffset;

                batchedIndices[indicesIndex++] = v0 * 2 + 1 + positionOffset;
                batchedIndices[indicesIndex++] = v1 * 2 + 1 + positionOffset;
                batchedIndices[indicesIndex++] = v1 * 2 + positionOffset;
            }

            buffer.offset += polygonCount * 2;
            buffer.indexOffset = indicesIndex;

            batchedIndexCounts[i] = indicesIndex - batchedIndexOffsets[i];
        }

        batchedIndices = IndexDatatype.createTypedArray(batchedPositions.length / 3, batchedIndices);

        var batchedIndicesLength = batchedDrawCalls.length;
        for (var m = 0; m < batchedIndicesLength; ++m) {
            var tempIds = batchedDrawCalls[m].batchIds;
            var count = 0;
            var tempIdsLength = tempIds.length;
            for (var n = 0; n < tempIdsLength; ++n) {
                count += batchedIndexCounts[tempIds[n]];
            }
            batchedDrawCalls[m].count = count;
        }

        var indexDatatype = (batchedIndices.BYTES_PER_ELEMENT === 2) ?  IndexDatatype.UNSIGNED_SHORT : IndexDatatype.UNSIGNED_INT;
        var packedBuffer = packBuffer(indexDatatype, boundingVolumes, batchedDrawCalls);

        transferableObjects.push(batchedPositions.buffer, batchedIndices.buffer, batchedIndexOffsets.buffer, batchedIndexCounts.buffer, batchedIds.buffer, packedBuffer.buffer);

        return {
            positions : batchedPositions.buffer,
            indices : batchedIndices.buffer,
            indexOffsets : batchedIndexOffsets.buffer,
            indexCounts : batchedIndexCounts.buffer,
            batchIds : batchedIds.buffer,
            packedBuffer : packedBuffer.buffer
        };
    }

    return createTaskProcessorWorker(createVectorTilePolygons);
});