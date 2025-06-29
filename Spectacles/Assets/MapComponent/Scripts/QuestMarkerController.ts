import {map, quaternionToPitch} from "./MapUtils"

import {LensConfig} from "SpectaclesInteractionKit.lspkg/Utils/LensConfig"
import {NavigationDataComponent} from "SpectaclesNavigationKit.lspkg/NavigationDataComponent/NavigationDataComponent"
import {Place} from "SpectaclesNavigationKit.lspkg/NavigationDataComponent/Place"
import {QuestMarker} from "./QuestMarker"
import { UICollisionSolver } from "../../NavigationKitAssets/Scripts/UICollisionDetector"
import {UpdateDispatcher} from "SpectaclesInteractionKit.lspkg/Utils/UpdateDispatcher"
import {UserPosition} from "SpectaclesNavigationKit.lspkg/NavigationDataComponent/UserPosition"
import WorldCameraFinderProvider from "SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import Event, { callback, PublicApi } from "SpectaclesInteractionKit.lspkg/Utils/Event"

const BOUNDARY_HALF_WIDTH_PROJECTION = 35
const BOUNDARY_HALF_WIDTH = 26
const BOUNDARY_HALF_HEIGHT = 35
const Y_POSITION_LERP_BUFFER = 10 * MathUtils.DegToRad
const VIEW_DETECT_ANGLE_BUFFER = 3 * MathUtils.DegToRad

enum MarkerPosition {
  TOP = 0,
  RIGHT = 1,
  BOTTOM = 2,
  LEFT = 3,
  CORNER = 4,
  INVIEW = 5,
}

interface MarkerPositionIndex {
  position: MarkerPosition
  index: number
}

/**
 * Manages the {@link QuestMarker}s registered and presents a set to navigation markers on the users display direction
 * them to that position.
 */
@component
export class QuestMarkerController extends BaseScriptComponent {
  @input
  public navigationComponent: NavigationDataComponent
  @input
  private questMarkerPrefab: ObjectPrefab
  @input
  private destinationPrefab: ObjectPrefab
  @input
  private inViewMaterial: Material
  @input
  private outOfViewMaterial: Material
  @input
  private scale: number = 1
  @input
  public markerImageOffsetInDegree: number = 0
  @input
  private markerHalfWidth = 5
  @input
  private markerHalfHeight = 5
  @input
  private labelHalfHeight = 0.7
  @input
  private displayOnlySelected: boolean = false

  private questMarkers: Map<string, QuestMarker> = new Map()
  private placeToQuestMarker: Map<Place, QuestMarker> = new Map()
  private destinationObjects: Map<string, SceneObject> = new Map()
  private pendingDestinationPlaces: Map<string, Place> = new Map()
  private camera: Camera
  private cameraTransform: Transform
  private halfFOV: number

  private uiCollisionSolver: UICollisionSolver = new UICollisionSolver()

  private leftElements: vec2[]
  private rightElements: vec2[]
  private topElements: vec2[]
  private bottomElements: vec2[]
  private inViewElements: vec4[]
  private markerPositions: MarkerPositionIndex[]
  private defaultLabelY: number
  private userPosition: UserPosition

  private updateDispatcher: UpdateDispatcher = LensConfig.getInstance().updateDispatcher

  // Add these new events
  private onQuestMarkerAddedEvent = new Event<{questMarker: QuestMarker, place: Place}>()
  public onQuestMarkerAdded: PublicApi<{questMarker: QuestMarker, place: Place}> = this.onQuestMarkerAddedEvent.publicApi()

  private onQuestMarkerRemovedEvent = new Event<QuestMarker>()
  public onQuestMarkerRemoved: PublicApi<QuestMarker> = this.onQuestMarkerRemovedEvent.publicApi()

  onAwake() {
    this.createEvent("OnStartEvent").bind(this.onStart.bind(this))
    this.updateDispatcher.createLateUpdateEvent("LateUpdateEvent").bind(this.onLateUpdate.bind(this))
  }

  onStart() {
    this.camera = WorldCameraFinderProvider.getInstance().getComponent()
    this.cameraTransform = WorldCameraFinderProvider.getInstance().getTransform()

    print("Camera initialized: " + (this.camera ? "yes" : "no"))
    print("Camera transform initialized: " + (this.cameraTransform ? "yes" : "no"))

    this.userPosition = this.navigationComponent.getUserPosition()
    print("User position initialized: " + (this.userPosition ? "yes" : "no"))

    this.navigationComponent.onNavigationStarted.add((place) => {
      this.updateSelected(place)
    })
  }

  onLateUpdate() {
    // Early return if camera hasn't been initialized yet
    if (!this.camera || !this.cameraTransform) {
      return
    }

    this.halfFOV = this.camera.fov / 2 - VIEW_DETECT_ANGLE_BUFFER

    const markerPlaneDistanceFromCamera = this.sceneObject
      .getTransform()
      .getWorldPosition()
      .distance(this.cameraTransform.getWorldPosition())
    const yOrientationOffset: number =
      -Math.abs(markerPlaneDistanceFromCamera) * Math.tan(quaternionToPitch(this.cameraTransform.getLocalRotation()))

    this.leftElements = []
    this.rightElements = []
    this.topElements = []
    this.bottomElements = []
    this.inViewElements = []
    this.markerPositions = new Array(this.questMarkers.size)

    let markerIndex = 0
    this.questMarkers.forEach((marker) => {
      // TODO: Handle null
      const distance = marker.getPhysicalDistance(this.userPosition) ?? 0

      const {orientation, xPosition, yPosition} = this.resolveMarkerPositionAndRotation(
        marker,
        this.userPosition,
        yOrientationOffset,
      )

      marker.setOrientation(orientation)
      marker.setDistance(distance)
      const localPosition = new vec3(
        xPosition,
        MathUtils.clamp(yPosition, -BOUNDARY_HALF_HEIGHT, BOUNDARY_HALF_HEIGHT),
        0,
      )

      marker.transform.setLocalPosition(localPosition)

      this.registerMarkerPositions(localPosition, markerIndex)
      markerIndex++
    })

    this.resolveMarkerPositions()
    this.updateDestinationObjects()
    this.retryPendingDestinationObjects()
  }

  /**
   * Updates the position and rotation of all destination 3D objects
   * Keeps them aligned with their corresponding quest markers
   */
  private updateDestinationObjects() {
    if (!this.destinationPrefab) {
      return
    }

    if (this.destinationObjects.size === 0) {
      return
    }

    // print("Updating " + this.destinationObjects.size + " destination objects")

    this.destinationObjects.forEach((destinationObject, markerId) => {
      const marker = this.questMarkers.get(markerId)
      if (!marker) {
        print("Removing destination object for missing marker: " + markerId)
        destinationObject.destroy()
        this.destinationObjects.delete(markerId)
        return
      }

      const distance = marker.getPhysicalDistance(this.userPosition) ?? 0
      const bearing = marker.getBearing(this.userPosition) ?? 0

      const cameraPosition = this.cameraTransform.getWorldPosition()
      const userForward = this.cameraTransform.back
        .projectOnPlane(vec3.up())
        .normalize()

      // Update position using the same logic as quest markers
      const markerLocationWorldPos = this.cameraTransform
        .getWorldPosition()
        .add(
          quat
            .fromEulerAngles(0, -bearing, 0)
            .multiplyVec3(userForward)
            .uniformScale(distance * 100)
        )
        .add(
          new vec3(
            0,
            1, // Fixed height offset
            0
          )
        )

      destinationObject.getTransform().setWorldPosition(markerLocationWorldPos)

      // Update rotation to face the user
      const directionToUser = cameraPosition
        .sub(markerLocationWorldPos)
        .normalize()
      const rotationToUser = quat.lookAt(directionToUser, vec3.up())
      destinationObject.getTransform().setWorldRotation(rotationToUser)

      // Update text if the destination object has a text component
      const distanceInMeters = Math.round(distance)
      const locationText = `${marker.markerLabel.text}\n${distanceInMeters}m`
      
      // Update text component using the robust method
      this.updateDestinationObjectText(destinationObject, locationText)
    })
  }

  public getQuestMarks(): QuestMarker[] {
    return Array.from(this.questMarkers.values())
  }

  public getDestinationObjects(): SceneObject[] {
    return Array.from(this.destinationObjects.values())
  }

  /**
   * Test method to manually create a destination object for debugging
   */
  public testCreateDestinationObject(): void {
    print("Testing destination object creation...")
    
    if (!this.destinationPrefab) {
      print("ERROR: Destination prefab is not assigned!")
      return
    }
    
    if (!this.cameraTransform) {
      print("ERROR: Camera transform is not initialized!")
      return
    }
    
    // Create a test destination object at a fixed position
    const testPosition = this.cameraTransform.getWorldPosition().add(new vec3(0, 0, -5))
    const destinationObject = this.destinationPrefab.instantiate(null)
    destinationObject.getTransform().setWorldPosition(testPosition)
    destinationObject.name = "TestDestination"
    
    print("Created test destination object at: " + testPosition)
    this.destinationObjects.set("test", destinationObject)
  }

  private resolveMarkerPositions() {
    const resolvedLeftElements = this.uiCollisionSolver.resolve1DCollisions(this.leftElements)
    const resolvedRightElements = this.uiCollisionSolver.resolve1DCollisions(this.rightElements)
    const resolvedBottomElements = this.uiCollisionSolver.resolve1DCollisions(this.bottomElements)
    const resolvedTopElements = this.uiCollisionSolver.resolve1DCollisions(this.topElements)
    const resolvedInViewElements = this.uiCollisionSolver.resolve2DCollisions(this.inViewElements)

    let markerIndex = 0
    this.questMarkers.forEach((marker) => {
      const localPosition = marker.transform.getLocalPosition()
      const labelLocalPosition = marker.markerLabel.getTransform().getLocalPosition()
      const distanceTextLocalPosition = marker.distanceText.getTransform().getLocalPosition()
      let x = localPosition.x
      let y = localPosition.y
      let labelLocalY = this.defaultLabelY
      if (this.markerPositions[markerIndex].position === MarkerPosition.LEFT) {
        y = resolvedLeftElements[this.markerPositions[markerIndex].index].y - this.markerHalfHeight
      } else if (this.markerPositions[markerIndex].position === MarkerPosition.RIGHT) {
        y = resolvedRightElements[this.markerPositions[markerIndex].index].y - this.markerHalfHeight
      } else if (this.markerPositions[markerIndex].position === MarkerPosition.BOTTOM) {
        x = resolvedBottomElements[this.markerPositions[markerIndex].index].y - this.markerHalfWidth
      } else if (this.markerPositions[markerIndex].position === MarkerPosition.TOP) {
        x = resolvedTopElements[this.markerPositions[markerIndex].index].y - this.markerHalfWidth
      }
      marker.transform.setLocalPosition(new vec3(x, y, localPosition.z))

      if (this.markerPositions[markerIndex].position === MarkerPosition.INVIEW) {
        labelLocalY =
          resolvedInViewElements[this.markerPositions[markerIndex].index].w -
          this.labelHalfHeight +
          this.defaultLabelY -
          y
      }
      marker.markerLabel
        .getTransform()
        .setLocalPosition(new vec3(labelLocalPosition.x, labelLocalY, labelLocalPosition.z))
      marker.distanceText
        .getTransform()
        .setLocalPosition(new vec3(distanceTextLocalPosition.x, -labelLocalY, distanceTextLocalPosition.z))
      markerIndex++
    })
    return markerIndex
  }

  private registerMarkerPositions(localPosition: vec3, markerIndex: number) {
    const isCorner =
      Math.abs(localPosition.y) === Math.abs(BOUNDARY_HALF_HEIGHT) &&
      Math.abs(localPosition.x) === Math.abs(BOUNDARY_HALF_WIDTH)

    if (isCorner) {
      this.markerPositions[markerIndex] = {
        position: MarkerPosition.CORNER,
        index: 0,
      }
    } else {
      if (localPosition.x === -BOUNDARY_HALF_WIDTH) {
        this.markerPositions[markerIndex] = {
          position: MarkerPosition.LEFT,
          index: this.leftElements.length,
        }
        this.leftElements.push(
          new vec2(localPosition.y - this.markerHalfHeight, localPosition.y + this.markerHalfHeight),
        )
      } else if (localPosition.x === BOUNDARY_HALF_WIDTH) {
        this.markerPositions[markerIndex] = {
          position: MarkerPosition.RIGHT,
          index: this.rightElements.length,
        }
        this.rightElements.push(
          new vec2(localPosition.y - this.markerHalfHeight, localPosition.y + this.markerHalfHeight),
        )
      } else if (localPosition.y === -BOUNDARY_HALF_HEIGHT) {
        this.markerPositions[markerIndex] = {
          position: MarkerPosition.BOTTOM,
          index: this.bottomElements.length,
        }
        this.bottomElements.push(
          new vec2(localPosition.x - this.markerHalfWidth, localPosition.x + this.markerHalfWidth),
        )
      } else if (localPosition.y === BOUNDARY_HALF_HEIGHT) {
        this.markerPositions[markerIndex] = {
          position: MarkerPosition.TOP,
          index: this.topElements.length,
        }
        this.topElements.push(new vec2(localPosition.x - this.markerHalfWidth, localPosition.x + this.markerHalfWidth))
      } else {
        this.markerPositions[markerIndex] = {
          position: MarkerPosition.INVIEW,
          index: this.inViewElements.length,
        }
        // Assume the in-view markers are all at the same height
        this.inViewElements.push(
          new vec4(
            localPosition.x - this.markerHalfWidth,
            localPosition.x + this.markerHalfWidth,
            localPosition.y - this.labelHalfHeight,
            localPosition.y + this.labelHalfHeight,
          ),
        )
      }
    }
  }

  private resolveMarkerPositionAndRotation(
    marker: QuestMarker,
    userPosition: UserPosition,
    yOrientationOffset: number,
  ): {orientation: number; xPosition: number; yPosition: number} {
    const bearing = marker.getBearing(userPosition)
    const inView = bearing < this.halfFOV && bearing > -this.halfFOV
    const backStartAngle = Math.PI - this.halfFOV
    const isOnTheBack = bearing > backStartAngle || bearing < -backStartAngle

    let screenPosition: vec2
    if (inView || isOnTheBack) {
      screenPosition = marker.getScreenSpaceCoordinate(userPosition, this.camera, yOrientationOffset) ?? new vec2(0, 0)
    } else {
      screenPosition = this.mapAngleToScreenPoint(bearing)
    }

    let orientation = -(bearing + this.markerImageOffsetInDegree * MathUtils.DegToRad)
    marker.setIsInView(inView, this.inViewMaterial, this.outOfViewMaterial)
    if (inView) {
      if (screenPosition.y > -BOUNDARY_HALF_HEIGHT && screenPosition.y < BOUNDARY_HALF_HEIGHT) {
        marker.setIsInView(true, this.inViewMaterial, this.outOfViewMaterial)
        orientation = 0
      } else {
        // Outside of vertical view
        marker.setIsInView(false, this.inViewMaterial, this.outOfViewMaterial)
        if (yOrientationOffset < -BOUNDARY_HALF_HEIGHT) {
          orientation = Math.PI * 2 - orientation
        }
      }
    } else {
      marker.setIsInView(false, this.inViewMaterial, this.outOfViewMaterial)
      const unrestrainedYPosition = screenPosition.y + yOrientationOffset
      const yPositionUnderTopBoundary = Math.min(unrestrainedYPosition, BOUNDARY_HALF_HEIGHT)
      const min = yPositionUnderTopBoundary < -BOUNDARY_HALF_HEIGHT ? -BOUNDARY_HALF_HEIGHT : yPositionUnderTopBoundary

      screenPosition.y = MathUtils.clamp(unrestrainedYPosition, min, yOrientationOffset)

      // Smooth transition the y-position to the bottom when the marker is on the back
      const absBearing = Math.abs(bearing)
      if (absBearing > backStartAngle - Y_POSITION_LERP_BUFFER) {
        const t = MathUtils.clamp((absBearing - backStartAngle + Y_POSITION_LERP_BUFFER) / Y_POSITION_LERP_BUFFER, 0, 1)
        screenPosition.y = MathUtils.lerp(screenPosition.y, -BOUNDARY_HALF_HEIGHT, t)
      }
    }
    return {
      orientation,
      xPosition: screenPosition.x,
      yPosition: screenPosition.y,
    }
  }

  public addQuestMark(questMarker: QuestMarker, place: Place | null = null): void {
    const uniqueIdentifier = questMarker.uniqueIdentifier
    if (!this.questMarkers.has(uniqueIdentifier)) {
      const questmarkObject = this.questMarkerPrefab.instantiate(this.sceneObject)
      questmarkObject.name = "QuestMark " + this.questMarkers.size

      questMarker.initialize(
        questmarkObject.getTransform(),
        this.scale,
        BOUNDARY_HALF_WIDTH_PROJECTION,
        BOUNDARY_HALF_WIDTH,
        BOUNDARY_HALF_HEIGHT,
        this.halfFOV,
      )
      this.defaultLabelY = questMarker.markerLabel.getTransform().getLocalPosition().y
      this.questMarkers.set(uniqueIdentifier, questMarker)

      // Create destination object if prefab is provided
      if (this.destinationPrefab && place) {
        print("Destination prefab found, attempting to create destination object")
        
        // Safety check - make sure camera and user position are ready
        if (!this.cameraTransform || !this.userPosition) {
          print("Camera or user position not ready yet, skipping destination object creation")
          return
        }
        
        const userLocation = this.userPosition.getGeoPosition()
        const placeLocation = place.getGeoPosition()
        
        print("User location: " + (userLocation ? "valid" : "null"))
        print("Place location: " + (placeLocation ? "valid" : "null"))
        
        if (userLocation && placeLocation) {
          this.createDestinationObject(questMarker, place, uniqueIdentifier)
        } else {
          print("Failed to get valid locations - userLocation: " + (userLocation ? "valid" : "null") + ", placeLocation: " + (placeLocation ? "valid" : "null"))
          // Store this place to retry later when user location becomes available
          if (!userLocation) {
            print("Storing place for later destination object creation: " + (place.name ?? "unnamed"))
            this.pendingDestinationPlaces.set(uniqueIdentifier, place)
          }
        }
      } else {
        if (!this.destinationPrefab) {
          print("Destination prefab is null - make sure to assign it in the inspector")
        }
        if (!place) {
          print("Place is null - destination objects only created when place is provided")
        }
      }

      if (!isNull(place)) {
        this.placeToQuestMarker.set(place, questMarker)
        // Trigger the added event
        this.onQuestMarkerAddedEvent.invoke({questMarker, place})
      }
    }
  }

  public removeQuestMark(questMark: QuestMarker): void {
    // Trigger the removed event before removing
    this.onQuestMarkerRemovedEvent.invoke(questMark)
    
    // Clean up destination object
    const destinationObject = this.destinationObjects.get(questMark.uniqueIdentifier)
    if (destinationObject) {
      destinationObject.destroy()
      this.destinationObjects.delete(questMark.uniqueIdentifier)
    }
    
    // Clean up pending destination place
    this.pendingDestinationPlaces.delete(questMark.uniqueIdentifier)
    
    this.questMarkers.delete(questMark.uniqueIdentifier)
    questMark.transform.getSceneObject().destroy()
  }

  /**
   * Cleanup handler that removes all markers and destination objects
   */
  public removeAllQuestMarks(): void {
    this.questMarkers.forEach((questMark) => {
      questMark.transform.getSceneObject().destroy()
    })
    this.questMarkers.clear()
    this.placeToQuestMarker.clear()
    
    this.destinationObjects.forEach((obj) => obj.destroy())
    this.destinationObjects.clear()
    
    this.pendingDestinationPlaces.clear()
  }

  private updateSelected(place: Place | null): void {
    const visible = !this.displayOnlySelected || isNull(place)
    this.questMarkers.forEach((m) => {
      m.setVisible(visible)
    })

    const selectedMarker = this.placeToQuestMarker.get(place)
    if (!isNull(selectedMarker)) {
      selectedMarker.setVisible(true)
    }
  }

  private mapAngleToScreenPoint(radians: number): vec2 {
    let x, y: number
    const degree = radians * MathUtils.RadToDeg
    var top = BOUNDARY_HALF_HEIGHT
    var left = -BOUNDARY_HALF_WIDTH
    var right = BOUNDARY_HALF_WIDTH
    var bottom = -BOUNDARY_HALF_HEIGHT

    const halfFOVInDegree = this.halfFOV * MathUtils.RadToDeg

    if (degree >= -halfFOVInDegree && degree <= halfFOVInDegree) {
      // top
      y = top
      x = map(degree, -halfFOVInDegree, halfFOVInDegree, left, right)
    } else if (degree > halfFOVInDegree && degree <= 180 - halfFOVInDegree) {
      // right
      y = map(degree, halfFOVInDegree, 180 - halfFOVInDegree, top, bottom)
      x = right
    } else if (degree < -halfFOVInDegree && degree >= -180 + halfFOVInDegree) {
      // left
      y = map(degree, -halfFOVInDegree, -180 + halfFOVInDegree, top, bottom)
      x = left
    } else if (degree < -180 + halfFOVInDegree) {
      // bottom
      y = bottom
      x = map(degree, -180 + halfFOVInDegree, -180, left, 0)
    } else {
      // bottom
      y = bottom
      x = map(degree, 180 - halfFOVInDegree, 180, right, 0)
    }

    return new vec2(x, y)
  }

  private createDestinationObject(questMarker: QuestMarker, place: Place, uniqueIdentifier: string): void {
    const userLocation = this.userPosition.getGeoPosition()
    const placeLocation = place.getGeoPosition()
    
    if (userLocation && placeLocation) {
      const distance = this.userPosition.getDistanceTo(place) ?? 0
      const bearing = this.userPosition.getBearingTo(place, false) ?? 0

      print("Distance: " + distance + "m, Bearing: " + bearing)

      // Calculate initial world position
      const cameraPosition = this.cameraTransform.getWorldPosition()
      const userForward = this.cameraTransform.back
        .projectOnPlane(vec3.up())
        .normalize()

      const markerLocationWorldPos = this.cameraTransform
        .getWorldPosition()
        .add(
          quat
            .fromEulerAngles(0, -bearing, 0)
            .multiplyVec3(userForward)
            .uniformScale(distance * 100)
        )
        .add(
          new vec3(
            0,
            1, // Fixed height offset
            0
          )
        )

      print("Attempting to instantiate destination prefab at position: " + markerLocationWorldPos)

      // Instantiate destination prefab at world position
      const destinationObject = this.destinationPrefab.instantiate(null)
      print("Destination object instantiated: " + destinationObject.name + ", enabled: " + destinationObject.enabled)
      
      const newWorldPosition = new vec3(markerLocationWorldPos.x, 50000, markerLocationWorldPos.z)
      destinationObject.getTransform().setWorldPosition(newWorldPosition)
      print("Set world position to: " + newWorldPosition)
      
      destinationObject.getTransform().setLocalScale(new vec3(1000, 100000, 1000))
      print("Set scale to: 1000, 100000, 1000")

      // Make the destination object face the user
      const directionToUser = cameraPosition
        .sub(markerLocationWorldPos)
        .normalize()
      const rotationToUser = quat.lookAt(directionToUser, vec3.up())
      destinationObject.getTransform().setWorldRotation(rotationToUser)
      print("Set rotation to face user")

      // Set name and text
      destinationObject.name = "Destination_" + uniqueIdentifier
      const locationName = place.name ?? "Unknown Location"
      const distanceInMeters = Math.round(distance)
      const locationText = `${locationName}\n${distanceInMeters}m`

      print("Created destination object: " + destinationObject.name + " with text: " + locationText)

      // Debug: Check basic properties
      print("Destination object enabled: " + destinationObject.enabled)
      print("Destination object children count: " + destinationObject.children.length)
      destinationObject.children.forEach((child, index) => {
        print("Child " + index + ": " + child.name + ", enabled: " + child.enabled)
      })

      // Update text component using the robust method
      this.updateDestinationObjectText(destinationObject, locationText)

      this.destinationObjects.set(uniqueIdentifier, destinationObject)
      print("Destination object added to tracking map. Total objects: " + this.destinationObjects.size)
    } else {
      print("Failed to get valid locations - userLocation: " + (userLocation ? "valid" : "null") + ", placeLocation: " + (placeLocation ? "valid" : "null"))
      // Store this place to retry later when user location becomes available
      if (!userLocation) {
        print("Storing place for later destination object creation: " + (place.name ?? "unnamed"))
        this.pendingDestinationPlaces.set(uniqueIdentifier, place)
      }
    }
  }

  /**
   * Try to create destination objects for places that were added before user location was available
   */
  private retryPendingDestinationObjects(): void {
    if (this.pendingDestinationPlaces.size === 0) {
      return
    }

    const userLocation = this.userPosition.getGeoPosition()
    if (!userLocation) {
      return // Still no user location
    }

    print("Retrying " + this.pendingDestinationPlaces.size + " pending destination objects")

    this.pendingDestinationPlaces.forEach((place, uniqueIdentifier) => {
      const questMarker = this.questMarkers.get(uniqueIdentifier)
      if (questMarker) {
        this.createDestinationObject(questMarker, place, uniqueIdentifier)
      }
      this.pendingDestinationPlaces.delete(uniqueIdentifier)
    })
  }

  private updateDestinationObjectText(destinationObject: SceneObject, locationText: string): void {
    // Try to find text component on the main object first
    let textComponent = destinationObject.getComponent("Component.Text")
    if (textComponent) {
      textComponent.text = locationText
      print("Updated text component on main object successfully")
      return
    }

    // Search through children for text component
    const children = destinationObject.children
    for (let i = 0; i < children.length; i++) {
      try {
        const child = destinationObject.getChild(i)
        textComponent = child.getComponent("Component.Text")
        if (textComponent) {
          textComponent.text = locationText
          print("Updated text component on child " + i + " successfully")
          return
        }
      } catch (error) {
        print("Error accessing child " + i + ": " + error)
      }
    }

    // print("No text component found in destination object hierarchy")
  }
}
